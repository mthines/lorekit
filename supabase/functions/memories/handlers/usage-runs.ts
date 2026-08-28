import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { UsageRunsQuerySchema } from '../../_shared/schemas/usage.ts';

/** The raw shape `lorekit_usage_runs` returns (bigints arrive as strings). */
interface RawUsageRunRow {
  correlation_id: string;
  session_kind: string | null;
  first_seen: string;
  last_seen: string;
  read_events: number | string;
  records_read: number | string;
  write_events: number | string;
  distinct_scopes: number | string;
  total_duration_ms: number | string;
}

/**
 * How far back an unbounded call looks — the `UNBOUNDED_STATS_RANGE` posture
 * `lib/queries/explorer-stats.ts` established: an all-time enumeration over
 * the highest-volume table in the schema is a performance cliff on exactly
 * the biggest accounts, so a bounded default is substituted and CAPTIONED
 * (`range` in the response) rather than the request silently returning less
 * than "all time" implies.
 */
const DEFAULT_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

interface RunsCursor {
  lastSeen: string;
  correlationId: string;
}

/** Opaque base64url-JSON cursor, matching the web's `{c, id}` keyset codec shape. */
function encodeCursor(cursor: RunsCursor): string {
  const json = JSON.stringify({ c: cursor.lastSeen, id: cursor.correlationId });
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a cursor. Fails closed to `null` (first page) — never throws. */
function decodeCursor(raw: string | undefined): RunsCursor | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const parsed = JSON.parse(json) as { c?: unknown; id?: unknown };
    if (typeof parsed.c !== 'string' || typeof parsed.id !== 'string' || !parsed.c || !parsed.id) return null;
    return { lastSeen: parsed.c, correlationId: parsed.id };
  } catch {
    return null;
  }
}

/**
 * GET /memories/usage/runs — enumerate runs (distinct `correlation_id`
 * values) the caller's own `usage_events` carry, each with what it read,
 * wrote, and touched (migration 00083's `lorekit_usage_runs`).
 *
 * The payoff view for `GET /memories/usage?correlation_id=`: that filters TO
 * one run; this is how a caller discovers which ones exist. REST-only — no
 * MCP tool, no CLI command (`telemetry-vocabulary.ts`).
 *
 * Keyset-paginated (`(last_seen, correlation_id)` desc), never OFFSET — the
 * Audit Logs precedent. The RPC applies its own `user_id` filter, so a
 * forged cursor can only mis-page the caller's OWN rows, never widen
 * visibility — the same reasoning that lets the web's `decodeCursor` fail
 * closed to "first page" instead of needing a signature.
 */
export async function handleUsageRuns(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, UsageRunsQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  const until = params.until ?? new Date().toISOString();
  const since = params.since ?? new Date(Date.parse(until) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();

  const cursor = decodeCursor(params.cursor);
  // A cursor string that fails to decode is NOT a 400: it degrades to "first
  // page", exactly like the web's own keyset cursor — a stale/forged/corrupt
  // cursor should never break the request, only its position in the list.
  if (params.cursor && !cursor) {
    span.setAttributes({ 'lorekit.cursor.invalid': true });
  }

  span.setAttributes({
    'lorekit.operation': 'memories.usage-runs',
    'lorekit.limit': params.limit,
  });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<RawUsageRunRow>('lorekit_usage_runs', {
    p_user_id: auth.userId ?? null,
    p_since: since,
    p_until: until,
    p_cursor_last_seen: cursor?.lastSeen ?? null,
    p_cursor_correlation_id: cursor?.correlationId ?? null,
    // One extra row requested so we know whether a next page exists, mirroring
    // `buildPage`'s own overflow-row convention elsewhere in this codebase.
    p_limit: params.limit + 1,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as RawUsageRunRow[];
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;

  const runs = page.map((r) => ({
    correlation_id: r.correlation_id,
    session_kind: r.session_kind,
    first_seen: new Date(r.first_seen).toISOString(),
    last_seen: new Date(r.last_seen).toISOString(),
    read_events: Number(r.read_events),
    records_read: Number(r.records_read),
    write_events: Number(r.write_events),
    distinct_scopes: Number(r.distinct_scopes),
    total_duration_ms: Number(r.total_duration_ms),
  }));

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ lastSeen: last.last_seen, correlationId: last.correlation_id }) : null;

  span.setAttributes({ 'lorekit.result_count': runs.length, 'lorekit.has_more': hasMore });
  return ok({ range: { since, until }, runs, next_cursor: nextCursor }, cors);
}
