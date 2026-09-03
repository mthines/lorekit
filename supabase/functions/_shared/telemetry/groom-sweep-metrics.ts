// The retention-policy nightly sweep's telemetry mapping — the pure half of
// the fix for the sweep being entirely invisible to Dash0. The impure halves
// are `supabase/functions/groom-sweep/index.ts` (the RPC read) and
// `_shared/telemetry/otlp-metrics.ts` (the POST); this module is the mapping
// in between, hoisted out for the same reason `db-query-metrics.ts` is: the
// decision that is easy to get silently wrong (whether a value is a
// cumulative counter or a per-run snapshot) is unit-testable here rather than
// only observable as a nonsensical rate() on a dashboard.
//
// `lorekit_groom_sweep()` (migrations 00088/00093) has always been a raw SQL
// function, called directly by pg_cron with no span, no metric, and no way to
// tell "ran and archived nothing" apart from "did not run" or "failed
// silently". `lorekit_groom_sweep_and_record()` (migration 00095) wraps it
// with a persistent counter row (`groom_sweep_stats`) so this module can
// export TRUE cumulative sums — matching `db-query-metrics.ts`'s convention —
// rather than per-run deltas that would need their own reset-detection
// machinery to be safe against a dropped tick.
//
// Two metrics:
//
//   lorekit.groom.sweep.runs      {run}     cumulative sweep executions
//   lorekit.groom.sweep.archived  {memory}  cumulative memories auto-archived
//
// `runs` answers "did the cron fire" — `increase(...)` over a window longer
// than the schedule (nightly, so > 24h) staying at 0 means the job stopped
// running. `archived` answers the regression half — a sustained drop to 0
// while `runs` keeps incrementing AND enabled auto policies exist means the
// sweep is running but no longer matching/archiving anything, worth alerting
// on separately from an outright stall.

/** One row of `lorekit_groom_sweep_and_record()`. */
export interface GroomSweepStatsRow {
  /** Cumulative count of sweep executions since `started_at`. */
  runs_total: number;
  /** Cumulative count of memories auto-archived since `started_at`. */
  archived_total: number;
  /** How many memories THIS run archived — a snapshot, not exported as a metric; carried as a span attribute instead. */
  archived_this_run: number;
  /** How many auto+enabled policies THIS run evaluated — a snapshot, span attribute only. */
  policies_evaluated: number;
  /** When the cumulative counters started (the counter row's creation time) — becomes each datapoint's `startTimeMs`. */
  started_at: string;
  /** When this run completed. Not exported; useful for logging/debugging only. */
  last_run_at: string | null;
}

/** A single datapoint of a cumulative sum. Matches `otlp-metrics.ts`'s `SumPoint`. */
export interface GroomSweepPoint {
  attributes: Record<string, string | number | boolean>;
  value: number;
  startTimeMs: number;
  timeMs: number;
}

/** A cumulative monotonic sum. Matches `otlp-metrics.ts`'s `SumMetric`. */
export interface GroomSweepMetric {
  name: string;
  unit: string;
  description: string;
  valueType: 'int' | 'double';
  points: GroomSweepPoint[];
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Resolve the cumulative series start from `started_at`.
 *
 * Mirrors `db-query-metrics.ts`'s `seriesStartMs`: an unparseable or missing
 * value falls back to the UNIX EPOCH ("cumulative since forever") rather than
 * to the observation time, which would make the datapoint a zero-length
 * series and either divide-by-zero or drop out of a `rate()`.
 */
function seriesStartMs(row: GroomSweepStatsRow): number {
  const parsed = Date.parse(row.started_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map one `lorekit_groom_sweep_and_record()` row to the two cumulative sums.
 *
 * @param row    the RPC row for this run.
 * @param nowMs  the observation time stamped on both datapoints — passed in
 *               rather than read from the clock so the mapping is pure.
 */
export function buildGroomSweepMetrics(
  row: GroomSweepStatsRow,
  nowMs: number,
): GroomSweepMetric[] {
  const startTimeMs = seriesStartMs(row);
  const point = (value: number): GroomSweepPoint => ({
    attributes: {},
    value,
    startTimeMs,
    timeMs: nowMs,
  });

  return [
    {
      name: 'lorekit.groom.sweep.runs',
      unit: '{run}',
      description: 'Cumulative number of nightly retention-policy sweep executions.',
      valueType: 'int',
      points: [point(num(row.runs_total))],
    },
    {
      name: 'lorekit.groom.sweep.archived',
      unit: '{memory}',
      description: 'Cumulative number of memories auto-archived by the nightly retention-policy sweep.',
      valueType: 'int',
      points: [point(num(row.archived_total))],
    },
  ];
}
