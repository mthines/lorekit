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
import { createTracedClient, type Span } from './otel.ts';
import type { DbClient } from './db-client.ts';

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
  /**
   * The EXACT scope the call touched (`repo::owner/name`, `global`, …),
   * normalised by `safeValidateScope` at the recording site. Distinct from
   * `scopeType`, which is the deliberately low-cardinality family
   * (`repo`/`branch`/…) and cannot answer "reads for THIS repo".
   *
   * Null means unattributed — the scope was absent, carried in a body the
   * router must not consume, or ungrammatical. Fail-safe by contract
   * (migration 00058): a telemetry dimension never fails the call it measures.
   */
  scope?: string | null;
  /**
   * Memory TAXONOMY — the bucket kind (`lesson`/`bus`/`signal`) and owning host
   * — so usage can be grouped by family and owner, not just tool name. Resolved
   * by `resolveKindHost` (schemas/tags) so it matches what the write STORED.
   * Null on non-write tools and on writes that carry neither an explicit value
   * nor a `loop::…` tag to infer from.
   */
  kind?: string | null;
  host?: string | null;
}

/**
 * Fire-and-forget structured usage event for plan-sizing analytics.
 * Never throws — a failed write must never break the primary operation.
 * Handed to EdgeRuntime.waitUntil so the event lands before the isolate dies.
 */
export function recordUsageEvent(
  db: DbClient,
  params: UsageEventParams,
): void {
  // ── Why `?? undefined` and not `?? null` ────────────────────────────────
  // Every parameter of `lorekit_record_usage_event` is declared `default null`
  // (00034, widened by 00044/00054/00056/00058), so the generated Args type
  // spells them `p_x?: string` — OPTIONAL, not nullable. An explicit `null` is
  // therefore not assignable, and this was 36 of the type errors this branch
  // set out to remove (9 lines × the 4 functions that reach this module).
  //
  // Omitting a key and passing NULL are equivalent HERE, and only because every
  // default is null: `undefined` is dropped by JSON.stringify, PostgREST omits
  // the argument, and the function applies its own default, which is null. If a
  // parameter ever gains a non-null default, this mapping silently changes
  // meaning — pass that one explicitly rather than letting it fall through.
  const p = Promise.resolve(db.rpc('lorekit_record_usage_event', {
    p_user_id:     params.userId ?? undefined,
    p_org_id:      params.orgId ?? undefined,
    p_plan_name:   params.planName ?? undefined,
    p_tool_name:   params.toolName,
    p_scope_type:  params.scopeType ?? undefined,
    p_auth_type:   params.authType,
    p_outcome:     params.outcome,
    p_duration_ms: params.durationMs ?? undefined,
    p_memory_count: params.memoryCount ?? undefined,
    p_result_count: params.resultCount ?? undefined,
    p_correlation_id: params.correlationId ?? undefined,
    p_client:      params.client ?? undefined,
    p_scope:       params.scope ?? undefined,
    // `kind`/`host` have been on `UsageEventParams` and on the writer RPC since
    // 00056, and the MCP handler has been resolving and passing them all along —
    // but they were never in this payload, so the RPC used its defaults and
    // every `usage_events.kind` / `.host` in the table is NULL. The columns were
    // dead the whole time, silently, because a telemetry write that drops a
    // dimension looks exactly like a telemetry write that succeeds.
    p_kind:        params.kind ?? undefined,
    p_host:        params.host ?? undefined,
    // `db.rpc(...)` is a THENABLE, not a Promise: its declared type is
    // `PromiseLike`, which has `.then` and no `.catch` — so the old
    // `.then(…).catch(…)` chain did not typecheck (4 more of the errors, again
    // one per reaching function). It did not misbehave, because postgrest-js
    // returns a real Promise at runtime, but the code was relying on that
    // rather than stating it. `Promise.resolve()` adopts the thenable, which
    // makes the type honest AND satisfies `EdgeRuntime.waitUntil`, whose
    // parameter is `Promise<unknown>` and never accepted a `PromiseLike`.
  })).then(() => { /* fire-and-forget */ }, () => { /* swallow */ });

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
 *
 * Pass `parentSpan` to have the lookup emit its own CLIENT span, the way every
 * other edge DB call does (`createTracedClient`, see `_shared/otel.ts`). It is
 * optional rather than required because the two existing callers differ: the
 * MCP transport resolves the plan inline on the request's critical path and
 * wants it timed, while `_shared/api/router.ts` starts it un-awaited purely to
 * annotate a usage event afterwards, so a child span there would routinely
 * outlive the handler span it hangs from.
 *
 * Untimed, this query was invisible: an `lorekit.mcp` span could report 0.885s
 * with only 0.084s accounted for by children, and none of the missing time had
 * a name.
 */
export async function getUserPlanName(
  db: DbClient,
  userId: string,
  parentSpan?: Span,
): Promise<string | null> {
  try {
    const query = parentSpan
      ? createTracedClient(db, parentSpan).from('user_plans')
      : db.from('user_plans');
    const { data } = await query
      .select('plan_name')
      .eq('user_id', userId)
      .maybeSingle();
    // `maybeSingle()` resolves to the row itself (or null) on both clients; the
    // traced wrapper's declared `PostgrestResponse<T[]>` describes the general
    // case, not this one, which is why the cast goes through `unknown`.
    return (data as unknown as { plan_name: string } | null)?.plan_name ?? 'free';
  } catch {
    return null;
  }
}
