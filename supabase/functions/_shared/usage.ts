/**
 * Structured usage events (`usage_events`, supabase/migrations/00034) for
 * plan-sizing analytics.
 *
 * THE single edge writer, used by both surfaces:
 *   - MCP  — one event per tool call (`mcp/mcp-handler.ts`).
 *   - REST — one event per dispatched route (`_shared/api/router.ts`).
 * `mcp/limits.ts` re-exports these so its existing import sites are unchanged;
 * there is no second implementation.
 *
 * Both entry points are non-throwing by contract: a telemetry write must never
 * break, slow down, or fail the operation it is measuring. `recordUsageEvent`
 * is fire-and-forget, `getUserPlanName` fails open to null.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

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
  /** Records this event touched (read result length / rows expired). Nullable. */
  resultCount?: number | null;
  /** Client-supplied grouping key (PR / session / job). Bounded, nullable. */
  correlationId?: string | null;
  /**
   * Which SURFACE made the call (`dashboard` / `cli` / `mcp` / `api`), from the
   * client-supplied `X-LoreKit-Client` header and validated against the closed
   * vocabulary by `parseUsageClient`. Null means unattributed.
   *
   * Distinct from `authType` (HOW the caller authenticated) and `toolName`
   * (WHAT they asked for): a dashboard read and an agent read over a Supabase
   * JWT are both `jwt` + `memory.list`. Migration 00054 uses it to keep the
   * dashboard's own reads out of the "Memories read" metric.
   */
  client?: string | null;
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
    p_result_count: params.resultCount ?? null,
    p_correlation_id: params.correlationId ?? null,
    p_client:      params.client ?? null,
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
