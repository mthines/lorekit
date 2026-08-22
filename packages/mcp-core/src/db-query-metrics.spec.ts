import { describe, it, expect } from 'vitest';

import {
  buildDbQueryMetrics,
  MAX_QUERY_TEXT_LENGTH,
  type DbQueryStatRow,
} from './db-query-metrics.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const RESET = '2026-08-01T00:00:00.000Z';

function row(overrides: Partial<DbQueryStatRow> = {}): DbQueryStatRow {
  return {
    queryid: '-4210984721098472109',
    query: 'select key, value from memories where scope = $1 limit $2',
    toplevel: true,
    calls: 1200,
    total_exec_ms: 4500,
    rows_returned: 36_000,
    stats_since: RESET,
    ...overrides,
  };
}

const byName = (rows: readonly DbQueryStatRow[], name: string) =>
  buildDbQueryMetrics(rows, NOW).find((m) => m.name === name);

describe('buildDbQueryMetrics — the three sums', () => {
  it('emits time, calls and rows for one statement', () => {
    const metrics = buildDbQueryMetrics([row()], NOW);
    expect(metrics.map((m) => m.name)).toEqual([
      'lorekit.db.query.time',
      'lorekit.db.query.calls',
      'lorekit.db.query.rows',
    ]);
    expect(metrics.every((m) => m.points.length === 1)).toBe(true);
  });

  it('converts Postgres MILLIseconds to the seconds OTel wants', () => {
    // The one unit conversion in the pipeline. 4500 ms of cumulative exec time
    // is 4.5 s — off by 1000x is invisible on a chart with no reference point.
    expect(byName([row({ total_exec_ms: 4500 })], 'lorekit.db.query.time')!.points[0].value).toBe(4.5);
    expect(byName([row()], 'lorekit.db.query.time')!.unit).toBe('s');
  });

  it('leaves counts as integers, untouched', () => {
    expect(byName([row({ calls: 1200 })], 'lorekit.db.query.calls')!.points[0].value).toBe(1200);
    expect(byName([row({ rows_returned: 36_000 })], 'lorekit.db.query.rows')!.points[0].value).toBe(36_000);
  });

  it('declares the wire type per measure (durations double, counts int)', () => {
    expect(byName([row()], 'lorekit.db.query.time')!.valueType).toBe('double');
    expect(byName([row()], 'lorekit.db.query.calls')!.valueType).toBe('int');
    expect(byName([row()], 'lorekit.db.query.rows')!.valueType).toBe('int');
  });

  it('returns nothing at all for no rows', () => {
    // Not three empty metrics — those render as three broken instruments.
    expect(buildDbQueryMetrics([], NOW)).toEqual([]);
  });
});

describe('series identity and timing', () => {
  it('stamps every point of one scrape with the SAME observation time', () => {
    const points = buildDbQueryMetrics([row(), row({ queryid: '77' })], NOW)
      .flatMap((m) => m.points);
    expect(points).not.toHaveLength(0);
    expect(points.every((p) => p.timeMs === NOW)).toBe(true);
  });

  it('uses the stats_reset time as the cumulative series start', () => {
    expect(byName([row()], 'lorekit.db.query.calls')!.points[0].startTimeMs).toBe(Date.parse(RESET));
  });

  it('falls back to the epoch — not now — when the view was never reset', () => {
    // `startTimeMs === timeMs` would be a zero-length series, which a backend
    // either divides by zero over or drops.
    const point = byName([row({ stats_since: null })], 'lorekit.db.query.calls')!.points[0];
    expect(point.startTimeMs).toBe(0);
    expect(point.startTimeMs).not.toBe(point.timeMs);
  });

  it('falls back to the epoch for an unparseable reset timestamp', () => {
    expect(byName([row({ stats_since: 'not-a-date' })], 'lorekit.db.query.calls')!.points[0].startTimeMs).toBe(0);
  });

  it('keeps queryid as the string Postgres gave us', () => {
    // int64. Parsing it into a JS number silently rounds and collapses two
    // distinct statements into one series.
    const big = '-9223372036854775701';
    expect(byName([row({ queryid: big })], 'lorekit.db.query.calls')!.points[0].attributes['db.queryid']).toBe(big);
  });
});

describe('datapoint attributes stay bounded', () => {
  it('carries queryid, db.system, text and toplevel — and nothing else', () => {
    expect(Object.keys(byName([row()], 'lorekit.db.query.calls')!.points[0].attributes).sort()).toEqual([
      'db.query.text',
      'db.query.toplevel',
      'db.queryid',
      'db.system',
    ]);
  });

  it('truncates an over-long statement', () => {
    const text = byName([row({ query: 'x'.repeat(5000) })], 'lorekit.db.query.calls')!
      .points[0].attributes['db.query.text'] as string;
    expect(text).toHaveLength(MAX_QUERY_TEXT_LENGTH);
  });

  it('omits db.query.text entirely when there is no statement', () => {
    const attributes = byName([row({ query: null })], 'lorekit.db.query.calls')!.points[0].attributes;
    expect(attributes).not.toHaveProperty('db.query.text');
  });

  it('omits toplevel when unknown rather than guessing true', () => {
    // A guessed `true` merges nested statements into the top-level bucket,
    // double-counting the work this dimension exists to separate.
    const attributes = byName([row({ toplevel: null })], 'lorekit.db.query.calls')!.points[0].attributes;
    expect(attributes).not.toHaveProperty('db.query.toplevel');
  });

  it('preserves a false toplevel (a statement inside a function body)', () => {
    expect(byName([row({ toplevel: false })], 'lorekit.db.query.calls')!
      .points[0].attributes['db.query.toplevel']).toBe(false);
  });

  it('never invents a tenant dimension', () => {
    // pg_stat_statements aggregates by statement shape across ALL callers, so
    // there is no user to attribute a row to. An invented one would both lie
    // and make the cardinality unbounded.
    const attributes = byName([row()], 'lorekit.db.query.calls')!.points[0].attributes;
    for (const key of Object.keys(attributes)) {
      expect(key).not.toMatch(/user|tenant|org|scope/i);
    }
  });
});

describe('unusable rows', () => {
  it('drops a row with no queryid', () => {
    // Without an identity every scrape would mint a fresh one-point series.
    expect(buildDbQueryMetrics([row({ queryid: null })], NOW)).toEqual([]);
    expect(buildDbQueryMetrics([row({ queryid: '' })], NOW)).toEqual([]);
  });

  it('keeps the usable rows alongside a dropped one', () => {
    const metrics = buildDbQueryMetrics([row(), row({ queryid: null })], NOW);
    expect(metrics[0].points).toHaveLength(1);
  });

  it('reports a null or non-finite counter as zero, not NaN', () => {
    const rows = [row({ calls: null, total_exec_ms: Number.NaN, rows_returned: undefined })];
    expect(byName(rows, 'lorekit.db.query.calls')!.points[0].value).toBe(0);
    expect(byName(rows, 'lorekit.db.query.time')!.points[0].value).toBe(0);
    expect(byName(rows, 'lorekit.db.query.rows')!.points[0].value).toBe(0);
  });
});
