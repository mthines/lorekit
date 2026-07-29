/**
 * Abuse guardrails for the production Deno MCP edge function: a per-user cap
 * on stored (active) memories, and a per-user request rate limit.
 *
 * Self-contained mirror of packages/mcp-core/src/limits.ts — the edge
 * function has no cross-package imports (Deno / Node.js MCP SDK
 * incompatibility), so this module deliberately duplicates the logic rather
 * than importing it. Keep the two in sync when either changes.
 *
 * The DB (supabase/migrations/00004_limits.sql + 00032_plans.sql) is the
 * single config source and the authoritative enforcer for the cap (a
 * BEFORE INSERT trigger) and the rate limit (an atomic Postgres-backed
 * fixed-window RPC). This module only translates DB-layer rejections into
 * actionable app-layer errors, wraps the rate-limit RPC call, and records
 * structured usage events for plan-sizing analytics.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createTracedClient, type Span } from '../_shared/otel.ts';

export type LimitErrorCode = 'memory_cap' | 'rate_limited';

/** Actionable error surfaced to the caller when a guardrail rejects a request. */
export class LimitError extends Error {
  code: LimitErrorCode;
  retryAfterSeconds?: number;

  constructor(code: LimitErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'LimitError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Custom SQLSTATE raised by the enforce_memory_cap() trigger. */
export const MEMORY_CAP_SQLSTATE = 'LK001';

/** Dashboard origin shown in cap/rate-limit messages, overridable per deploy. */
const DEFAULT_LOREKIT_URL = 'https://lorekit.io';

/**
 * Resolve the dashboard URL from the environment, falling back to the canonical
 * origin. Read at call time (not module load) so a deploy's `LOREKIT_APP_URL`
 * override always takes effect.
 */
function lorekitUrl(): string {
  return Deno.env.get('LOREKIT_APP_URL') || DEFAULT_LOREKIT_URL;
}

export function memoryCapMessage(limit?: number, planName?: string): string {
  const plan = planName && planName !== 'free' ? `your ${planName}-plan limit` : 'the free-plan limit';
  const ceiling = limit ? `${plan} of ${limit} stored memories` : 'your stored-memories limit';
  return `You've reached ${ceiling}. Archive or delete unused memories, or upgrade your plan — see ${lorekitUrl()} (or contact support) to increase it.`;
}

export function rateLimitMessage(retryAfterSeconds: number): string {
  return `Too many requests — you're being rate limited. Retry after ${retryAfterSeconds}s, or raise your limit — see ${lorekitUrl()} (or contact support) to increase it.`;
}

/**
 * Translate a DB error into an actionable LimitError when it was raised by
 * the enforce_memory_cap() trigger (SQLSTATE 'LK001'). Any other error is
 * returned unchanged so callers can rethrow/wrap it as before.
 */
export function translateCapError(err: unknown, limit?: number): unknown {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code !== MEMORY_CAP_SQLSTATE) return err;

  const message = (err as { message?: string } | null | undefined)?.message ?? '';
  const parsedLimit = message.match(/limit=(\d+)/)?.[1];
  const effectiveLimit = parsedLimit ? Number(parsedLimit) : limit;

  return new LimitError('memory_cap', memoryCapMessage(effectiveLimit));
}

/**
 * Call the lorekit_check_rate_limit RPC and return the allow/deny decision.
 * Fails open (allows the request) on an RPC error — availability over strict
 * throttling; the cap trigger still protects storage during an outage.
 */
export async function checkRateLimit(
  db: ReturnType<typeof createClient>,
  userId: string,
  span: Span,
  windowSeconds = 60,
): Promise<{ allowed: boolean; retryAfterSeconds: number; currentCount?: number; limitValue?: number }> {
  const tracedDb = createTracedClient(db, span);
  try {
    const { data, error } = await tracedDb.rpc('lorekit_check_rate_limit', {
      p_user_id: userId,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      span.error(`RateLimitRpcError: ${error.message}`);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: Boolean(row?.allowed),
      retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
      currentCount: row?.current_count != null ? Number(row.current_count) : undefined,
      limitValue: row?.limit_value != null ? Number(row.limit_value) : undefined,
    };
  } catch (err) {
    span.error(`RateLimitException: ${(err as Error).message}`);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

// ── Usage event recording ─────────────────────────────────────────────────────

export interface UsageEventParams {
  userId: string | null;
  orgId?: string | null;
  planName?: string | null;
  toolName: string;
  scopeType?: string | null;
  authType: 'api_key' | 'jwt' | 'service';
  outcome: 'ok' | 'cap_exceeded' | 'rate_limited' | 'permission_denied' | 'error';
  durationMs?: number | null;
  memoryCount?: number | null;
}

/**
 * Fire-and-forget structured usage event for plan-sizing analytics.
 * Never throws — a failed write must never break the primary operation.
 * Handed to EdgeRuntime.waitUntil so the event lands before the isolate dies.
 */
export function recordUsageEvent(
  db: ReturnType<typeof createClient>,
  params: UsageEventParams,
): void {
  const p = db.rpc('lorekit_record_usage_event', {
    p_user_id:     params.userId,
    p_org_id:      params.orgId ?? null,
    p_plan_name:   params.planName ?? null,
    p_tool_name:   params.toolName,
    p_scope_type:  params.scopeType ?? null,
    p_auth_type:   params.authType,
    p_outcome:     params.outcome,
    p_duration_ms: params.durationMs ?? null,
    p_memory_count: params.memoryCount ?? null,
  }).then(() => { /* fire-and-forget */ }).catch(() => { /* swallow */ });

  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (typeof edgeRuntime?.waitUntil === 'function') {
    edgeRuntime.waitUntil(p);
  } else {
    void p;
  }
}

/**
 * Look up the plan name for a user — used to annotate usage events and span
 * attributes. Fails open (returns null) on any error.
 */
export async function getUserPlanName(
  db: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await db
      .from('user_plans')
      .select('plan_name')
      .eq('user_id', userId)
      .maybeSingle();
    return (data as { plan_name: string } | null)?.plan_name ?? 'free';
  } catch {
    return null;
  }
}

