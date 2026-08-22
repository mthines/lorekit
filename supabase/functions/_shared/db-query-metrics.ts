// Mirror of packages/mcp-core/src/telemetry/db-query-metrics.ts, self-contained for the
// Deno edge tree (which cannot cross-import the Node package — same pattern as
// io-ledger.ts and created-at.ts). Keep behaviourally identical to the mcp-core
// copy; the vitest suite over that copy is the shared guard, and
// `edge-parity.spec.ts` asserts this file stays in sync with it.
//
// The edge is the ONLY caller: `profiling/index.ts` feeds it the RPC rows.
//
// `pg_stat_statements` rows → OTel cumulative sums.
//
// The pure half of LoreKit's query-level profiling. The impure half is
// `supabase/functions/profiling/index.ts` (the RPC read) and
// `supabase/functions/_shared/otlp-metrics.ts` (the POST); this module is the
// mapping in between, hoisted out so the decisions that are easy to get
// silently wrong — the unit conversion, the reset timestamp, the attribute set
// — are unit-testable rather than only observable as a wrong number on a
// dashboard.
//
// Three metrics come out of one read, all cumulative monotonic sums:
//
//   lorekit.db.query.time   seconds   total execution time
//   lorekit.db.query.calls  {call}    times executed
//   lorekit.db.query.rows   {row}     rows returned or affected
//
// They are exported as CUMULATIVE rather than differenced here on purpose:
// `pg_stat_statements` counters are cumulative since `stats_reset`, so handing
// them over as-is lets the backend compute `rate()` and detect a reset from the
// series start time. Mean latency is then a derived query
// (rate(time) / rate(calls)) rather than a fourth metric that can disagree with
// the other two.
//
// Mirrored self-contained into the Deno edge tree
// (supabase/functions/_shared/db-query-metrics.ts) because the edge runtime
// cannot cross-import this package — the same pattern as io-ledger.ts and
// created-at.ts. Keep the two copies behaviourally identical; the vitest suite
// here is the guard.

/** One row of `lorekit_db_query_stats()`, as PostgREST returns it. */
export interface DbQueryStatRow {
  /** `pg_stat_statements.queryid`, as TEXT — it is an int64 and would lose precision as a JS number. */
  queryid: string | null;
  /** The normalised statement, whitespace-collapsed and truncated by the RPC. */
  query: string | null;
  /** False for a statement executed inside a function body. */
  toplevel?: boolean | null;
  calls: number | null;
  /** Cumulative execution time in MILLIseconds — what Postgres reports. */
  total_exec_ms: number | null;
  rows_returned: number | null;
  /** `pg_stat_statements_info.stats_reset` as an ISO string, when known. */
  stats_since: string | null;
}

/** A single datapoint of a cumulative sum. Matches `otlp-metrics.ts`'s `SumPoint`. */
export interface DbQueryPoint {
  attributes: Record<string, string | number | boolean>;
  value: number;
  startTimeMs: number;
  timeMs: number;
}

/** A cumulative monotonic sum. Matches `otlp-metrics.ts`'s `SumMetric`. */
export interface DbQueryMetric {
  name: string;
  unit: string;
  description: string;
  valueType: 'int' | 'double';
  points: DbQueryPoint[];
}

/** Longest query text carried as a metric attribute. */
export const MAX_QUERY_TEXT_LENGTH = 512;

/**
 * A row is only usable if it identifies WHICH statement it describes.
 *
 * Without a `queryid` a datapoint cannot be tied to a series across scrapes, so
 * every scrape would create a new one-point series — cardinality growth that
 * looks like data. The counters themselves may legitimately be null (a
 * statement with no rows column populated); those become 0.
 */
function isUsable(row: DbQueryStatRow): boolean {
  return typeof row.queryid === 'string' && row.queryid.length > 0;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Resolve the cumulative series start.
 *
 * `stats_since` is `pg_stat_statements_info.stats_reset`, which is null until
 * the view has ever been reset. Falling back to the observation time would be
 * wrong in a specific, invisible way: a start equal to the timestamp makes the
 * datapoint a zero-length series, and a backend computing a rate over it either
 * divides by zero or drops the point. Falling back to the UNIX EPOCH instead
 * says "cumulative since forever", which is exactly what an unreset counter is.
 */
function seriesStartMs(row: DbQueryStatRow): number {
  if (!row.stats_since) return 0;
  const parsed = Date.parse(row.stats_since);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The bounded dimensions each datapoint carries.
 *
 * `db.queryid` is the series identity. `db.query.text` is the human label and
 * is bounded by the RPC's own truncation — re-clamped here so the invariant
 * holds even if this module is ever fed rows from somewhere else.
 * `db.query.toplevel` separates a statement executed directly from the same
 * statement executed inside a plpgsql body, which otherwise double-counts:
 * LoreKit's writes run inside RPCs, so the outer `select memory_write(...)` and
 * its inner statements both appear, and summing across them would count the
 * same work twice.
 *
 * Deliberately NOT included: `user_id`, scope, or anything tenant-derived.
 * `pg_stat_statements` aggregates by statement SHAPE across all callers, so it
 * has no tenant to report — and inventing one would both lie and make the
 * cardinality unbounded.
 */
function pointAttributes(row: DbQueryStatRow): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    'db.queryid': row.queryid as string,
    'db.system': 'postgresql',
  };
  if (row.query) attributes['db.query.text'] = row.query.slice(0, MAX_QUERY_TEXT_LENGTH);
  // Only when Postgres actually told us. An absent `toplevel` is unknown, and a
  // guessed `true` would silently merge nested statements into the top-level
  // bucket — the double-count this dimension exists to prevent.
  if (typeof row.toplevel === 'boolean') attributes['db.query.toplevel'] = row.toplevel;
  return attributes;
}

/**
 * Map stat rows to the three cumulative sums.
 *
 * @param rows   what `lorekit_db_query_stats()` returned.
 * @param nowMs  the observation time stamped on every datapoint. Passed in
 *               rather than read from the clock so the mapping is pure and one
 *               scrape's points all share an identical timestamp — points from
 *               the same read must not straddle two milliseconds.
 * @returns one metric per measure, with the empty ones dropped so a scrape that
 *          found nothing produces an empty array rather than three empty
 *          metrics (which OTLP accepts but which show up as three broken
 *          instruments).
 */
export function buildDbQueryMetrics(
  rows: readonly DbQueryStatRow[],
  nowMs: number,
): DbQueryMetric[] {
  const usable = rows.filter(isUsable);

  const point = (row: DbQueryStatRow, value: number): DbQueryPoint => ({
    attributes: pointAttributes(row),
    value,
    startTimeMs: seriesStartMs(row),
    timeMs: nowMs,
  });

  const metrics: DbQueryMetric[] = [
    {
      name: 'lorekit.db.query.time',
      // SECONDS, per the OTel convention for durations — Postgres reports
      // milliseconds, so this is the one unit conversion in the pipeline and
      // the reason this mapping is tested.
      unit: 's',
      description: 'Cumulative server-side execution time per statement shape.',
      valueType: 'double',
      points: usable.map((row) => point(row, num(row.total_exec_ms) / 1000)),
    },
    {
      name: 'lorekit.db.query.calls',
      unit: '{call}',
      description: 'Cumulative number of executions per statement shape.',
      valueType: 'int',
      points: usable.map((row) => point(row, num(row.calls))),
    },
    {
      name: 'lorekit.db.query.rows',
      unit: '{row}',
      description: 'Cumulative rows returned or affected per statement shape.',
      valueType: 'int',
      points: usable.map((row) => point(row, num(row.rows_returned))),
    },
  ];

  return metrics.filter((m) => m.points.length > 0);
}
