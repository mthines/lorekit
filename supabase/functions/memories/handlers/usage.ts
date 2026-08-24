import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { ok, badRequest } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { UsageStatsQuerySchema } from '../../_shared/schemas/usage.ts';
import {
  parseUsageWindow,
  parseCorrelationId,
  summarizeUsageRows,
  rollupByScopeType,
  UsageStatsError,
  type UsageStatRow,
} from '../../_shared/telemetry/usage-stats.ts';

/** The raw shape `lorekit_usage_stats` returns (bigints arrive as strings). */
interface RawUsageRow {
  tool_name: string;
  outcome: string;
  scope_type: string | null;
  client: string | null;
  kind: string | null;
  host: string | null;
  event_count: number | string;
  record_count: number | string;
  total_duration_ms: number | string | null;
}

/**
 * GET /memories/usage — aggregate usage statistics for the caller's own
 * activity, read back from usage_events (migration 00034).
 *
 * The grouping runs in Postgres (`lorekit_usage_stats`, migration 00043), for
 * the same reason as GET /memories/scopes: a `select` + client-side reduce is
 * silently truncated past PostgREST's row cap. The RPC is tenant-scoped
 * internally (self-only, service-role escape hatch), so there is deliberately no
 * `applyRestTenantScope` here — there is no query to scope.
 *
 * The window is chosen by the caller via `period` or explicit `since`/`until`;
 * `parseUsageWindow` validates it into a half-open `[since, until)`. The summary
 * and per-scope-type rollup are computed by the pure `summarizeUsageRows` /
 * `rollupByScopeType` from the SAME rows returned as `by_tool`, so the headline
 * numbers can never disagree with the detail.
 */
export async function handleUsage(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'memories.usage' });

  const v = validateQuery(req, UsageStatsQuerySchema, cors);
  if (!v.ok) return v.response;

  let window: ReturnType<typeof parseUsageWindow>;
  try {
    window = parseUsageWindow(v.data);
  } catch (e) {
    if (e instanceof UsageStatsError) return badRequest(e.message, cors);
    throw e;
  }

  // Optional grouping filter — restrict to one PR / session / job. On a READ we
  // fail loud: a malformed correlation_id that silently degraded to null would
  // return account-wide totals dressed up as one PR's — a misleading analytics
  // number. (The write header keeps degrade-to-null; a bad tag there is benign,
  // it just doesn't get grouped. Here the caller asked to filter and we can't.)
  let correlationId: string | null = null;
  if (v.data.correlation_id != null) {
    correlationId = parseCorrelationId(v.data.correlation_id);
    if (correlationId === null) {
      return badRequest(
        'correlation_id contains characters outside [A-Za-z0-9_-./:#@] or exceeds 200 chars',
        cors,
      );
    }
  }

  const tracedDb = createTracedClient(db, span);
  // Service-role callers have no user id; the RPC recognises a null p_user_id
  // from a service_role JWT as "no tenant filter", matching GET /memories.
  const { data, error } = await tracedDb.rpc<RawUsageRow>('lorekit_usage_stats', {
    p_user_id: auth.userId ?? null,
    p_since: window.since,
    p_until: window.until,
    p_correlation_id: correlationId,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  // The highest memory_count snapshot recorded on a write event in this
  // window (migration 00081/00034) — "how full WAS this account", distinct
  // from the plan page's existing LIVE count. A separate scalar call: this
  // value is not derivable from the grouped by_tool rows above (a per-event
  // snapshot has no sensible sum/group). Fails open to null rather than
  // failing the whole request — this is a bonus field, not the point of the
  // call.
  let peakMemoryCount: number | null = null;
  const peakResult = await tracedDb.rpc<number | null>('lorekit_usage_memory_count_peak', {
    p_user_id: auth.userId ?? null,
    p_since: window.since,
    p_until: window.until,
  });
  if (!peakResult.error) {
    peakMemoryCount = peakResult.data == null ? null : Number(peakResult.data);
  } else {
    span.error(`DB (memory_count_peak, non-fatal): ${peakResult.error.message}`);
  }

  const rows: UsageStatRow[] = ((data ?? []) as RawUsageRow[]).map((r) => ({
    tool_name: r.tool_name,
    outcome: r.outcome,
    scope_type: r.scope_type,
    client: r.client,
    kind: r.kind,
    host: r.host,
    event_count: Number(r.event_count),
    record_count: Number(r.record_count),
    total_duration_ms: r.total_duration_ms == null ? null : Number(r.total_duration_ms),
  }));

  span.setAttributes({ 'lorekit.result_count': rows.length });

  return ok({
    range: { since: window.since, until: window.until },
    correlation_id: correlationId,
    summary: { ...summarizeUsageRows(rows), peak_memory_count: peakMemoryCount },
    by_tool: rows,
    by_scope_type: rollupByScopeType(rows),
  }, cors);
}
