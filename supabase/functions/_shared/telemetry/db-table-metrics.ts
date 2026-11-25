// Mirror of packages/mcp-core/src/telemetry/db-table-metrics.ts, self-contained
// for the Deno edge tree (which cannot cross-import the Node package). Keep it
// behaviourally identical: `edge-parity.spec.ts` compares the two with comments
// stripped, and the vitest suite over the mcp-core copy is the shared guard.
// The edge is the only caller: `profiling/index.ts` feeds it the RPC rows.
//
// `lorekit_db_table_stats()` rows → OTel metrics (`lorekit.db.table.*`).
//
// The per-table half of LoreKit's query-level profiling (migration 00125). The
// impure halves are `supabase/functions/profiling/index.ts` (the RPC read) and
// `supabase/functions/_shared/telemetry/otlp-metrics.ts` (the POST); this module
// is the mapping in between, kept pure so the unit, the series start and the
// attribute set are unit-tested rather than only seen as a wrong number on a
// dashboard. Sibling of `db-query-metrics.ts`, which maps `pg_stat_statements`.
//
// Most counters are cumulative since the database's last `pg_stat_reset()` and
// go out as cumulative monotonic sums with that reset as the series start, so
// Dash0 does the differencing and reads a reset as a new series. The HOT-update
// ratio is then `rate(tup_hot_upd) / rate(tup_upd)`.
//
// `n_live_tup` / `n_dead_tup` are not counters — they are estimates of the
// table's current state, and they go DOWN when autovacuum runs — so they go out
// as gauges.
//
// Mirrored self-contained into the Deno edge tree
// (supabase/functions/_shared/telemetry/db-table-metrics.ts) because the edge
// runtime cannot cross-import this package. `edge-parity.spec.ts` asserts the
// two copies stay identical; the vitest suite here is the behavioural guard.

/** One row of `lorekit_db_table_stats()`, as PostgREST returns it. */
export interface DbTableStatRow {
  table_name: string | null;
  n_tup_ins: number | null;
  n_tup_upd: number | null;
  n_tup_hot_upd: number | null;
  n_tup_del: number | null;
  n_live_tup: number | null;
  n_dead_tup: number | null;
  seq_scan: number | null;
  idx_scan: number | null;
  autovacuum_count: number | null;
  heap_blks_read: number | null;
  heap_blks_hit: number | null;
  idx_blks_read: number | null;
  idx_blks_hit: number | null;
  /** `pg_stat_database.stats_reset` as an ISO string, null until a reset has ever happened. */
  stats_since: string | null;
}

/** One datapoint. Matches `otlp-metrics.ts`'s `SumPoint`. */
export interface DbTablePoint {
  attributes: Record<string, string | number | boolean>;
  value: number;
  startTimeMs: number;
  timeMs: number;
}

/** A cumulative sum or a gauge. Matches `otlp-metrics.ts`'s `SumMetric`. */
export interface DbTableMetric {
  name: string;
  unit: string;
  description: string;
  valueType: 'int' | 'double';
  kind: 'sum' | 'gauge';
  points: DbTablePoint[];
}

type Measure = {
  column: Exclude<keyof DbTableStatRow, 'table_name' | 'stats_since'>;
  name: string;
  unit: string;
  kind: 'sum' | 'gauge';
  description: string;
};

const MEASURES: readonly Measure[] = [
  { column: 'n_tup_ins', name: 'tup_ins', unit: '{row}', kind: 'sum', description: 'Cumulative rows inserted.' },
  { column: 'n_tup_upd', name: 'tup_upd', unit: '{row}', kind: 'sum', description: 'Cumulative rows updated, HOT updates included.' },
  { column: 'n_tup_hot_upd', name: 'tup_hot_upd', unit: '{row}', kind: 'sum', description: 'Cumulative rows updated in place (HOT): no index entries written.' },
  { column: 'n_tup_del', name: 'tup_del', unit: '{row}', kind: 'sum', description: 'Cumulative rows deleted.' },
  { column: 'seq_scan', name: 'seq_scan', unit: '{scan}', kind: 'sum', description: 'Cumulative sequential scans started.' },
  { column: 'idx_scan', name: 'idx_scan', unit: '{scan}', kind: 'sum', description: 'Cumulative index scans started.' },
  { column: 'heap_blks_read', name: 'heap_blks_read', unit: '{block}', kind: 'sum', description: 'Cumulative table blocks read from disk (not in shared buffers).' },
  { column: 'heap_blks_hit', name: 'heap_blks_hit', unit: '{block}', kind: 'sum', description: 'Cumulative table blocks found in shared buffers.' },
  { column: 'idx_blks_read', name: 'idx_blks_read', unit: '{block}', kind: 'sum', description: 'Cumulative index blocks read from disk, all indexes of the table.' },
  { column: 'idx_blks_hit', name: 'idx_blks_hit', unit: '{block}', kind: 'sum', description: 'Cumulative index blocks found in shared buffers, all indexes of the table.' },
  { column: 'autovacuum_count', name: 'autovacuum_count', unit: '{run}', kind: 'sum', description: 'Cumulative autovacuum runs on the table.' },
  { column: 'n_live_tup', name: 'live_tup', unit: '{row}', kind: 'gauge', description: 'Estimated live rows.' },
  { column: 'n_dead_tup', name: 'dead_tup', unit: '{row}', kind: 'gauge', description: 'Estimated dead rows awaiting vacuum.' },
];

/** Every metric name this module can emit, in emission order. */
export const DB_TABLE_METRIC_NAMES: readonly string[] = MEASURES.map((m) => `lorekit.db.table.${m.name}`);

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * The series start: the database's last stats reset, or the UNIX epoch when it
 * was never reset. Never the observation time, which would make every point a
 * zero-length series (the same rule as `db-query-metrics.ts`).
 */
function seriesStartMs(row: DbTableStatRow): number {
  if (!row.stats_since) return 0;
  const parsed = Date.parse(row.stats_since);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map stat rows to `lorekit.db.table.*`.
 *
 * A row with no `table_name` cannot be tied to a series and is dropped. The
 * attribute set is `db.table` and `db.system` only: the reader returns a fixed
 * table allowlist, so the cardinality is bounded by that list, and nothing here
 * is tenant-derived.
 *
 * @param nowMs the observation time on every point — passed in so one scrape's
 *              points share one timestamp and the mapping stays pure.
 * @returns one metric per measure; empty when no row is usable.
 */
export function buildDbTableMetrics(rows: readonly DbTableStatRow[], nowMs: number): DbTableMetric[] {
  const usable = rows.filter((row) => typeof row.table_name === 'string' && row.table_name.length > 0);
  if (usable.length === 0) return [];

  return MEASURES.map((m) => ({
    name: `lorekit.db.table.${m.name}`,
    unit: m.unit,
    description: m.description,
    valueType: 'int' as const,
    kind: m.kind,
    points: usable.map((row) => ({
      attributes: { 'db.table': row.table_name as string, 'db.system': 'postgresql' },
      value: num(row[m.column]),
      startTimeMs: seriesStartMs(row),
      timeMs: nowMs,
    })),
  }));
}
