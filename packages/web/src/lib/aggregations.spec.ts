import { describe, it, expect } from 'vitest';
import {
  RANGE_BUCKETS,
  dayCountsFromActivity,
  trendRowsFromActivity,
  computeRangeTrends,
  pctChange,
  windowChange,
  scopeWindowChange,
  computeCountTrend,
} from './aggregations';

// ── dayCountsFromActivity ─────────────────────────────────────────────────────

describe('dayCountsFromActivity', () => {
  it('returns an empty series for no buckets', () => {
    expect(dayCountsFromActivity([])).toEqual([]);
  });

  it('sums the counts of every bucket that falls on the same UTC day', () => {
    expect(
      dayCountsFromActivity([
        { bucket: '2026-07-01T01:00:00.000Z', scope: 'global', count: 2 },
        { bucket: '2026-07-01T09:00:00.000Z', scope: 'project::x', count: 3 },
        { bucket: '2026-07-02T00:00:00.000Z', scope: 'global', count: 1 },
      ]),
    ).toEqual([
      { date: '2026-07-01', count: 5 },
      { date: '2026-07-02', count: 1 },
    ]);
  });

  it('sorts by date ascending regardless of input order', () => {
    const result = dayCountsFromActivity([
      { bucket: '2026-07-05T00:00:00.000Z', scope: 'global', count: 1 },
      { bucket: '2026-07-03T00:00:00.000Z', scope: 'global', count: 1 },
    ]);
    expect(result.map((d) => d.date)).toEqual(['2026-07-03', '2026-07-05']);
  });
});

// ── trendRowsFromActivity ─────────────────────────────────────────────────────

describe('trendRowsFromActivity', () => {
  it('expands each cell into one row per counted memory, at the bucket start', () => {
    expect(
      trendRowsFromActivity([{ bucket: '2026-07-01T01:00:00.000Z', scope: 'global', count: 3 }]),
    ).toEqual([
      { scope: 'global', created_at: '2026-07-01T01:00:00.000Z' },
      { scope: 'global', created_at: '2026-07-01T01:00:00.000Z' },
      { scope: 'global', created_at: '2026-07-01T01:00:00.000Z' },
    ]);
  });

  it('keeps each cell’s scope, so distinct-scope counts survive the round trip', () => {
    const rows = trendRowsFromActivity([
      { bucket: '2026-07-01T01:00:00.000Z', scope: 'global', count: 1 },
      { bucket: '2026-07-01T01:00:00.000Z', scope: 'project::x', count: 1 },
    ]);
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(['global', 'project::x']));
  });

  it('drops nothing and adds nothing for a zero count', () => {
    expect(trendRowsFromActivity([{ bucket: '2026-07-01T00:00:00.000Z', scope: 'g', count: 0 }])).toEqual([]);
  });
});

// ── pctChange ─────────────────────────────────────────────────────────────────

describe('pctChange', () => {
  it('is 0 when both periods are empty', () => {
    expect(pctChange(0, 0)).toBe(0);
  });

  it('treats growth from zero as +100%', () => {
    expect(pctChange(5, 0)).toBe(100);
  });

  it('computes a rounded percentage change', () => {
    expect(pctChange(15, 10)).toBe(50);
    expect(pctChange(5, 10)).toBe(-50);
    expect(pctChange(10, 10)).toBe(0);
  });
});

// ── windowChange ──────────────────────────────────────────────────────────────

describe('windowChange', () => {
  it('returns 0 when all values are zero', () => {
    expect(windowChange(new Array(14).fill(0), 7)).toBe(0);
  });

  it('returns +100% when recent window has activity and prev is zero', () => {
    const values = new Array(7).fill(0).concat(new Array(7).fill(1));
    expect(windowChange(values, 7)).toBe(100);
  });

  it('returns -50% when recent is half of prev', () => {
    const values = new Array(7).fill(10).concat(new Array(7).fill(5));
    expect(windowChange(values, 7)).toBe(-50);
  });

  it('returns 0 when both windows are equal', () => {
    const values = new Array(14).fill(3);
    expect(windowChange(values, 7)).toBe(0);
  });

  it('uses the last k vs preceding k from a longer array', () => {
    // 30-entry array: 16 zeros, then [1×7] (prev), then [2×7] (recent) → +100%
    const values = new Array(16).fill(0).concat(new Array(7).fill(1)).concat(new Array(7).fill(2));
    expect(windowChange(values, 7)).toBe(100);
  });
});

// ── scopeWindowChange ─────────────────────────────────────────────────────────

describe('scopeWindowChange', () => {
  it('returns 0 when all buckets are empty', () => {
    const buckets = Array.from({ length: 14 }, () => new Set<string>());
    expect(scopeWindowChange(buckets, 7)).toBe(0);
  });

  it('returns +100% when only the recent window has scopes', () => {
    const empty = () => new Set<string>();
    const buckets = [
      ...Array.from({ length: 7 }, empty),
      ...Array.from({ length: 7 }, () => new Set(['global'])),
    ];
    expect(scopeWindowChange(buckets, 7)).toBe(100);
  });

  it('unions scopes across days within a window (distinct, not sum of daily counts)', () => {
    // Regression: 3 scopes each active on 1 recent day vs 1 scope active all 7 prior days.
    // Sum-of-daily-counts: recent=3, prev=7 → -57% (wrong).
    // Union-distinct:       recent=3, prev=1 → +200% (correct).
    const empty = () => new Set<string>();
    const prevBuckets = Array.from({ length: 7 }, () => new Set(['global']));
    const recentBuckets = [
      new Set(['scope-a', 'scope-b']),
      new Set(['scope-a', 'scope-c']),
      new Set(['scope-b', 'scope-c']),
      ...Array.from({ length: 4 }, empty),
    ];
    const buckets = [...Array.from({ length: 16 }, empty), ...prevBuckets, ...recentBuckets];
    expect(scopeWindowChange(buckets, 7)).toBe(200);
  });

  it('returns 0 when the same scopes are active in both windows', () => {
    const both = () => new Set(['global', 'project::a']);
    const buckets = Array.from({ length: 14 }, both);
    expect(scopeWindowChange(buckets, 7)).toBe(0);
  });

  it('handles partial overlap: scopes added in the recent window', () => {
    const prevBuckets = Array.from({ length: 7 }, () => new Set(['scope-a']));
    const recentBuckets = Array.from({ length: 7 }, () => new Set(['scope-a', 'scope-b']));
    expect(scopeWindowChange([...prevBuckets, ...recentBuckets], 7)).toBe(100);
  });

  it('handles a scope active only 1 day in each window', () => {
    const empty = () => new Set<string>();
    const prevBuckets = [new Set(['scope-a']), ...Array.from({ length: 6 }, empty)];
    const recentBuckets = [new Set(['scope-a', 'scope-b']), ...Array.from({ length: 6 }, empty)];
    const buckets = [...Array.from({ length: 16 }, empty), ...prevBuckets, ...recentBuckets];
    expect(scopeWindowChange(buckets, 7)).toBe(100);
  });
});

// ── computeRangeTrends ────────────────────────────────────────────────────────

describe('computeRangeTrends', () => {
  const NOW = '2026-07-24T12:00:00Z'; // Friday
  const sum = (points: { value: number }[]) => points.reduce((a, p) => a + p.value, 0);

  it('charts the recent window per range (7d → 7 daily, 30d → 30 daily, 24h → 24 hourly)', () => {
    expect(computeRangeTrends([], NOW, RANGE_BUCKETS['7d']).lessons.points).toHaveLength(7);
    expect(computeRangeTrends([], NOW, RANGE_BUCKETS['7d']).scopes.points).toHaveLength(7);
    expect(computeRangeTrends([], NOW, RANGE_BUCKETS['30d']).lessons.points).toHaveLength(30);
    expect(computeRangeTrends([], NOW, RANGE_BUCKETS['24h']).lessons.points).toHaveLength(24);
  });

  it('is all-zero and flat for empty input', () => {
    const t = computeRangeTrends([], NOW, RANGE_BUCKETS['7d']);
    expect(t.lessons.points.every((p) => p.value === 0)).toBe(true);
    expect(t.lessons.changePct).toBe(0);
    expect(t.scopes.changePct).toBe(0);
    expect(t.activeScopes).toBe(0);
  });

  it('counts lessons per day with the last bucket = today (7d)', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-24T10:00:00Z' }, // today
      { scope: 'project::a', created_at: '2026-07-24T11:00:00Z' }, // today
      { scope: 'project::a', created_at: '2026-07-23T09:00:00Z' }, // yesterday
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    const n = t.lessons.points.length;
    expect(t.lessons.points[n - 1]!.value).toBe(2);
    expect(t.lessons.points[n - 2]!.value).toBe(1);
    expect(sum(t.lessons.points)).toBe(3);
  });

  it('counts distinct scopes per day (7d)', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-24T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-24T11:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-24T12:00:00Z' }, // dup scope same day
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    const n = t.scopes.points.length;
    expect(t.scopes.points[n - 1]!.value).toBe(2); // global + project::a
  });

  it('counts lessons per hour for the last 24h', () => {
    // NOW is 12:00 → last bucket is [12:00,13:00), which is empty here.
    const rows = [
      { scope: 'global', created_at: '2026-07-24T11:30:00Z' }, // 11:00 bucket
      { scope: 'global', created_at: '2026-07-24T10:15:00Z' }, // 10:00 bucket
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['24h']);
    const n = t.lessons.points.length;
    expect(n).toBe(24);
    expect(t.lessons.points[n - 1]!.value).toBe(0); // 12:00
    expect(t.lessons.points[n - 2]!.value).toBe(1); // 11:00
    expect(t.lessons.points[n - 3]!.value).toBe(1); // 10:00
  });

  it('excludes rows older than the comparison window (7d)', () => {
    const rows = [{ scope: 'global', created_at: '2026-01-01T10:00:00Z' }];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    expect(sum(t.lessons.points)).toBe(0);
    expect(t.lessons.changePct).toBe(0);
  });

  it('lessons.changePct compares the recent window vs. the preceding one (7d)', () => {
    // Prior 7 days (Jul 11–17): 1/day = 7. Recent 7 days (Jul 18–24): 2/day = 14 → +100%.
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => ({
        scope: 'global',
        created_at: `2026-07-${String(11 + i).padStart(2, '0')}T10:00:00Z`,
      })),
      ...Array.from({ length: 14 }, (_, i) => ({
        scope: 'global',
        created_at: `2026-07-${String(18 + Math.floor(i / 2)).padStart(2, '0')}T${i % 2 === 0 ? '10' : '14'}:00:00Z`,
      })),
    ];
    expect(computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']).lessons.changePct).toBe(100);
  });

  it('scopes.changePct uses window-distinct union, not sum of per-bucket counts (7d)', () => {
    // Recent 7 days (Jul 18–24): 3 scopes, each active on exactly 1 day → union = 3
    // Prior 7 days (Jul 11–17):  1 scope active all 7 days               → union = 1
    // Sum-based (buggy): recent=3, prev=7 → −57% (wrong direction)
    // Union-based (fix):  3 vs 1           → +200%
    const rows = [
      { scope: 'global', created_at: '2026-07-11T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-12T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-13T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-14T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-15T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-16T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-17T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-18T10:00:00Z' },
      { scope: 'project::b', created_at: '2026-07-19T10:00:00Z' },
      { scope: 'project::c', created_at: '2026-07-20T10:00:00Z' },
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    expect(t.scopes.changePct).toBe(200);
    // activeScopes is the recent-window distinct union used for the card value.
    expect(t.activeScopes).toBe(3);
  });

  it('scopes.changePct is 0 when the same scope set is active in both windows (7d)', () => {
    const scopes = ['global', 'project::a', 'project::b'];
    const rows = [
      ...scopes.map((scope, i) => ({
        scope,
        created_at: `2026-07-${String(11 + i).padStart(2, '0')}T10:00:00Z`,
      })),
      ...scopes.map((scope, i) => ({
        scope,
        created_at: `2026-07-${String(18 + i).padStart(2, '0')}T10:00:00Z`,
      })),
    ];
    expect(computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']).scopes.changePct).toBe(0);
  });

  it('activeScopes counts distinct scopes active in the selected window (7d)', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-18T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-20T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-22T10:00:00Z' }, // duplicate scope, same window
      { scope: 'project::b', created_at: '2026-07-24T10:00:00Z' },
      { scope: 'project::old', created_at: '2026-07-17T23:59:00Z' }, // outside 7d
    ];
    expect(computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']).activeScopes).toBe(3);
  });

  it('a wider range admits older rows: 10 days back is out for 7d, in for 30d', () => {
    const rows = [{ scope: 'project::x', created_at: '2026-07-14T10:00:00Z' }]; // 10 days back
    expect(computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']).activeScopes).toBe(0);
    expect(computeRangeTrends(rows, NOW, RANGE_BUCKETS['30d']).activeScopes).toBe(1);
  });
});

// ── computeRangeTrends → newScopes (the additive Scopes series) ───────────────

describe('computeRangeTrends → newScopes', () => {
  const NOW = '2026-07-24T12:00:00Z';
  const sum = (points: { value: number }[]) => points.reduce((a, p) => a + p.value, 0);

  it('is all-zero for empty input', () => {
    const t = computeRangeTrends([], NOW, RANGE_BUCKETS['7d']);
    expect(t.newScopes.points).toHaveLength(7);
    expect(sum(t.newScopes.points)).toBe(0);
  });

  it('counts a scope once, in the bucket it first appears in', () => {
    const rows = [
      { scope: 'project::a', created_at: '2026-07-19T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-21T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-23T10:00:00Z' },
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    // Charted window is Jul 18–24; the scope debuts on the 19th (index 1).
    expect(t.newScopes.points.map((p) => p.value)).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(sum(t.newScopes.points)).toBe(t.activeScopes);
  });

  it('sums to activeScopes when every scope is distinct', () => {
    const rows = [
      { scope: 'project::a', created_at: '2026-07-19T10:00:00Z' },
      { scope: 'project::b', created_at: '2026-07-20T10:00:00Z' },
      { scope: 'project::c', created_at: '2026-07-21T10:00:00Z' },
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    expect(sum(t.newScopes.points)).toBe(3);
    expect(t.activeScopes).toBe(3);
  });

  it('sums to activeScopes for a mixed set — the card invariant, every range', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-18T01:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T09:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-20T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-20T11:00:00Z' },
      { scope: 'project::b', created_at: '2026-07-23T10:00:00Z' },
      { scope: 'project::old', created_at: '2026-06-30T10:00:00Z' }, // outside 7d, inside 30d
      { scope: 'project::x', created_at: '2026-07-24T11:30:00Z' },
    ];
    for (const range of ['24h', '7d', '30d'] as const) {
      const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS[range]);
      expect(sum(t.newScopes.points)).toBe(t.activeScopes);
    }
  });

  it('keeps the breadth changePct of the distinct-scope series', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-11T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-18T10:00:00Z' },
      { scope: 'project::b', created_at: '2026-07-19T10:00:00Z' },
    ];
    const t = computeRangeTrends(rows, NOW, RANGE_BUCKETS['7d']);
    expect(t.newScopes.changePct).toBe(t.scopes.changePct);
  });
});

// ── computeCountTrend ─────────────────────────────────────────────────────────

describe('computeCountTrend', () => {
  const NOW = '2026-07-24T12:00:00Z';
  const sum = (points: { value: number }[]) => points.reduce((a, p) => a + p.value, 0);

  it('charts the recent window per range', () => {
    expect(computeCountTrend([], NOW, RANGE_BUCKETS['7d']).points).toHaveLength(7);
    expect(computeCountTrend([], NOW, RANGE_BUCKETS['30d']).points).toHaveLength(30);
    expect(computeCountTrend([], NOW, RANGE_BUCKETS['24h']).points).toHaveLength(24);
  });

  it('is all-zero and flat for an empty series', () => {
    const t = computeCountTrend([], NOW, RANGE_BUCKETS['7d']);
    expect(sum(t.points)).toBe(0);
    expect(t.changePct).toBe(0);
  });

  it('sums the in-window buckets — the bars add up to the headline', () => {
    const rows = [
      { bucket: '2026-07-18T00:00:00.000Z', count: 5 },
      { bucket: '2026-07-20T00:00:00.000Z', count: 7 },
      { bucket: '2026-07-24T00:00:00.000Z', count: 2 },
      { bucket: '2026-07-10T00:00:00.000Z', count: 99 }, // prior window, not charted
    ];
    const t = computeCountTrend(rows, NOW, RANGE_BUCKETS['7d']);
    expect(sum(t.points)).toBe(14);
    expect(t.points.map((p) => p.value)).toEqual([5, 0, 7, 0, 0, 0, 2]);
  });

  it('aligns hour buckets with the day the 24h grid ends on', () => {
    const rows = [
      { bucket: '2026-07-24T12:00:00.000Z', count: 3 }, // the current hour — last bar
      { bucket: '2026-07-24T11:00:00.000Z', count: 1 },
    ];
    const t = computeCountTrend(rows, NOW, RANGE_BUCKETS['24h']);
    expect(t.points[t.points.length - 1]).toEqual({ label: '12:00', value: 3 });
    expect(t.points[t.points.length - 2]).toEqual({ label: '11:00', value: 1 });
  });

  it('compares the charted window against the immediately preceding one', () => {
    const rows = [
      { bucket: '2026-07-13T00:00:00.000Z', count: 10 }, // prior 7d
      { bucket: '2026-07-20T00:00:00.000Z', count: 20 }, // recent 7d
    ];
    expect(computeCountTrend(rows, NOW, RANGE_BUCKETS['7d']).changePct).toBe(100);
  });

  it('ignores buckets outside the 2× window and unparseable timestamps', () => {
    const rows = [
      { bucket: '2025-01-01T00:00:00.000Z', count: 500 },
      { bucket: 'not-a-date', count: 500 },
      { bucket: '2026-07-22T00:00:00.000Z', count: 4 },
    ];
    const t = computeCountTrend(rows, NOW, RANGE_BUCKETS['7d']);
    expect(sum(t.points)).toBe(4);
  });
});

/**
 * AC-4 for the Explorer's stats header: **every card with a series is additive
 * — summing its bars reproduces its headline.**
 *
 * The property is what makes the header trustworthy: the bars sit directly
 * under the number so the eye can check the claim, and a card whose chart and
 * total disagreed would be worse than no chart. It already held for the
 * Overview; these pin it for the header's exact composition, including the
 * scope-filtered rows the header feeds in.
 */
describe('stats-header additivity', () => {
  const NOW_H = '2026-07-24T12:00:00.000Z';
  const sumOf = (points: { value: number }[]) => points.reduce((t, p) => t + p.value, 0);

  const ACTIVITY = [
    { bucket: '2026-07-24T09:00:00.000Z', scope: 'repo::a/b', count: 3 },
    { bucket: '2026-07-24T10:00:00.000Z', scope: 'repo::a/b', count: 2 },
    { bucket: '2026-07-24T10:00:00.000Z', scope: 'global', count: 5 },
    { bucket: '2026-07-24T11:00:00.000Z', scope: 'project::x', count: 1 },
  ];

  it('Written: the bars sum to the headline', () => {
    const rows = trendRowsFromActivity(ACTIVITY);
    const trends = computeRangeTrends(rows, NOW_H, RANGE_BUCKETS['24h']);
    expect(sumOf(trends.lessons.points)).toBe(11);
  });

  it('Scopes: the NEW-scope bars sum to the distinct total, not to a per-bucket count', () => {
    // The reason the Scopes card charts first-seen scopes: `repo::a/b` is
    // active in two buckets but is ONE unit of breadth. A distinct-per-bucket
    // series would sum to 4 against a headline of 3.
    const rows = trendRowsFromActivity(ACTIVITY);
    const trends = computeRangeTrends(rows, NOW_H, RANGE_BUCKETS['24h']);
    expect(trends.activeScopes).toBe(3);
    expect(sumOf(trends.newScopes.points)).toBe(trends.activeScopes);
  });

  it('Read: the bars sum to the headline', () => {
    const readBuckets = [
      { bucket: '2026-07-24T09:00:00.000Z', scope: 'repo::a/b', count: 7 },
      { bucket: '2026-07-24T10:00:00.000Z', scope: null, count: 4 },
    ];
    expect(sumOf(computeCountTrend(readBuckets, NOW_H, RANGE_BUCKETS['24h']).points)).toBe(11);
  });

  it('stays additive when the header narrows the rows to one scope', () => {
    const rows = trendRowsFromActivity(ACTIVITY, 'repo::a/b');
    const trends = computeRangeTrends(rows, NOW_H, RANGE_BUCKETS['24h']);
    expect(sumOf(trends.lessons.points)).toBe(5);
    expect(trends.activeScopes).toBe(1);
    expect(sumOf(trends.newScopes.points)).toBe(trends.activeScopes);
  });
});

describe('trendRowsFromActivity scope filter', () => {
  const CELLS = [
    { bucket: '2026-07-24T09:00:00.000Z', scope: 'repo::a/b', count: 2 },
    { bucket: '2026-07-24T09:00:00.000Z', scope: 'branch::a/b::main', count: 3 },
    { bucket: '2026-07-24T10:00:00.000Z', scope: 'global', count: 1 },
  ];

  it('keeps every cell when no scope is given', () => {
    expect(trendRowsFromActivity(CELLS)).toHaveLength(6);
    expect(trendRowsFromActivity(CELLS, null)).toHaveLength(6);
    expect(trendRowsFromActivity(CELLS, undefined)).toHaveLength(6);
  });

  it('matches the scope EXACTLY — a repo does not include its branches', () => {
    // Must agree with what selecting a scope filters the LIST to; a prefix match
    // here would make the header count memories the list below does not show.
    const rows = trendRowsFromActivity(CELLS, 'repo::a/b');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === 'repo::a/b')).toBe(true);
  });

  it('yields nothing for a scope with no activity, rather than falling back to all', () => {
    // The dangerous failure: a no-match filter that degrades to "everything"
    // shows the account's numbers under an empty scope's name.
    expect(trendRowsFromActivity(CELLS, 'repo::nope/nope')).toEqual([]);
  });
});
