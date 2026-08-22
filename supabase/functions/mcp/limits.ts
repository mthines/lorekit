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
import type { DbClient } from '../_shared/db-client.ts';

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
  db: DbClient,
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
//
// MOVED to ../_shared/usage.ts. The REST router records usage events too
// (one per dispatched route), and it must use the SAME writer — two copies
// would drift the moment either side gained a field. Re-exported here so
// mcp-handler.ts's existing `from './limits.ts'` import sites are unchanged
// and there is still exactly one implementation.
//
// Nothing about the mcp-core ↔ edge `limits.ts` relationship changes: this
// file was already only a PARTIAL mirror (it carries Deno-specific imports and
// is deliberately excluded from edge-parity.spec.ts's whole-file comparison),
// and the moved functions have no mcp-core counterpart at all — usage-event
// recording is edge-only. The parity that does exist (LimitError,
// translateCapError, the message builders, checkRateLimit — all above this
// line) is untouched.
export { recordUsageEvent, getUserPlanName, type UsageEventParams } from '../_shared/usage.ts';

