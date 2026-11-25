import { describe, it, expect } from 'vitest';

import { buildDbTableMetrics, DB_TABLE_METRIC_NAMES, type DbTableStatRow } from './db-table-metrics.js';

const NOW = Date.parse('2026-11-25T17:00:00.000Z');
const RESET = '2026-11-01T00:00:00.000Z';

function row(overrides: Partial<DbTableStatRow> = {}): DbTableStatRow {
  return {
    table_name: 'memories',
    n_tup_ins: 100,
    n_tup_upd: 50,
    n_tup_hot_upd: 45,
    n_tup_del: 2,
    n_live_tup: 98,
    n_dead_tup: 7,
    seq_scan: 3,
    idx_scan: 900,
    autovacuum_count: 4,
    heap_blks_read: 12,
    heap_blks_hit: 3400,
    idx_blks_read: 8,
    idx_blks_hit: 5100,
    stats_since: RESET,
    ...overrides,
  };
}

const metric = (rows: readonly DbTableStatRow[], name: string) =>
  buildDbTableMetrics(rows, NOW).find((m) => m.name === `lorekit.db.table.${name}`);

describe('buildDbTableMetrics', () => {
  it('emits every lorekit.db.table.* measure, one point per table', () => {
    const metrics = buildDbTableMetrics([row(), row({ table_name: 'audit_log' })], NOW);
    expect(metrics.map((m) => m.name)).toEqual(DB_TABLE_METRIC_NAMES);
    expect(DB_TABLE_METRIC_NAMES).toEqual([
      'lorekit.db.table.tup_ins',
      'lorekit.db.table.tup_upd',
      'lorekit.db.table.tup_hot_upd',
      'lorekit.db.table.tup_del',
      'lorekit.db.table.seq_scan',
      'lorekit.db.table.idx_scan',
      'lorekit.db.table.heap_blks_read',
      'lorekit.db.table.heap_blks_hit',
      'lorekit.db.table.idx_blks_read',
      'lorekit.db.table.idx_blks_hit',
      'lorekit.db.table.autovacuum_count',
      'lorekit.db.table.live_tup',
      'lorekit.db.table.dead_tup',
    ]);
    expect(metrics.every((m) => m.points.length === 2)).toBe(true);
  });

  it('carries each column into its own measure', () => {
    expect(metric([row()], 'tup_upd')?.points[0].value).toBe(50);
    expect(metric([row()], 'tup_hot_upd')?.points[0].value).toBe(45);
    expect(metric([row()], 'heap_blks_read')?.points[0].value).toBe(12);
    expect(metric([row()], 'idx_blks_hit')?.points[0].value).toBe(5100);
    expect(metric([row()], 'dead_tup')?.points[0].value).toBe(7);
  });

  it('exports counters as sums and the live/dead tuple estimates as gauges', () => {
    const metrics = buildDbTableMetrics([row()], NOW);
    const gauges = metrics.filter((m) => m.kind === 'gauge').map((m) => m.name);
    expect(gauges).toEqual(['lorekit.db.table.live_tup', 'lorekit.db.table.dead_tup']);
    expect(metrics.filter((m) => m.kind === 'sum')).toHaveLength(11);
    expect(metrics.every((m) => m.valueType === 'int')).toBe(true);
  });

  it('labels every point with db.table and nothing tenant-derived', () => {
    for (const m of buildDbTableMetrics([row({ table_name: 'rate_limit_counters' })], NOW)) {
      expect(m.points[0].attributes).toEqual({ 'db.table': 'rate_limit_counters', 'db.system': 'postgresql' });
    }
  });

  it('drops a row that names no table', () => {
    const metrics = buildDbTableMetrics([row({ table_name: null }), row({ table_name: '' }), row()], NOW);
    expect(metrics.every((m) => m.points.length === 1)).toBe(true);
    expect(buildDbTableMetrics([row({ table_name: null })], NOW)).toEqual([]);
    expect(buildDbTableMetrics([], NOW)).toEqual([]);
  });

  it('starts each series at the stats reset, or the epoch when never reset', () => {
    expect(metric([row()], 'tup_ins')?.points[0]).toMatchObject({ startTimeMs: Date.parse(RESET), timeMs: NOW });
    expect(metric([row({ stats_since: null })], 'tup_ins')?.points[0].startTimeMs).toBe(0);
    expect(metric([row({ stats_since: 'not a date' })], 'tup_ins')?.points[0].startTimeMs).toBe(0);
  });

  it('reads a missing or bigint-as-string counter as a number', () => {
    expect(metric([row({ idx_scan: null })], 'idx_scan')?.points[0].value).toBe(0);
    expect(metric([row({ n_tup_upd: '9007' as unknown as number })], 'tup_upd')?.points[0].value).toBe(9007);
  });
});
