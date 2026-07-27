import { describe, it, expect } from 'vitest';
import {
  aggregateByScope,
  aggregateByDay,
  computeStatTrends,
  pctChange,
  windowChange,
  scopeWindowChange,
} from './aggregations';

// ── aggregateByScope ──────────────────────────────────────────────────────────

describe('aggregateByScope', () => {
  it('returns empty array for no rows', () => {
    expect(aggregateByScope([])).toEqual([]);
  });

  it('counts a single row correctly', () => {
    const rows = [{ scope: 'global', created_at: '2026-07-01T10:00:00Z' }];
    const result = aggregateByScope(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ scope: 'global', total: 1, lastActivity: '2026-07-01T10:00:00Z' });
  });

  it('counts multiple rows in the same scope', () => {
    const rows = [
      { scope: 'project::lorekit', created_at: '2026-07-01T10:00:00Z' },
      { scope: 'project::lorekit', created_at: '2026-07-02T10:00:00Z' },
      { scope: 'project::lorekit', created_at: '2026-07-03T10:00:00Z' },
    ];
    const result = aggregateByScope(rows);
    expect(result).toHaveLength(1);
    expect(result[0]!.total).toBe(3);
  });

  it('tracks the most-recent lastActivity per scope', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-01T08:00:00Z' },
      { scope: 'global', created_at: '2026-07-03T12:00:00Z' },
      { scope: 'global', created_at: '2026-07-02T06:00:00Z' },
    ];
    const result = aggregateByScope(rows);
    expect(result[0]!.lastActivity).toBe('2026-07-03T12:00:00Z');
  });

  it('handles multiple scopes correctly', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-01T10:00:00Z' },
      { scope: 'project::lorekit', created_at: '2026-07-04T10:00:00Z' },
      { scope: 'global', created_at: '2026-07-02T10:00:00Z' },
      { scope: 'repo::mthines/lorekit', created_at: '2026-07-03T10:00:00Z' },
    ];
    const result = aggregateByScope(rows);
    expect(result).toHaveLength(3);
    const totalCounts = result.reduce((sum, s) => sum + s.total, 0);
    expect(totalCounts).toBe(4);
  });

  it('sorts scopes by lastActivity descending', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-01T10:00:00Z' },
      { scope: 'project::lorekit', created_at: '2026-07-05T10:00:00Z' },
      { scope: 'repo::x', created_at: '2026-07-03T10:00:00Z' },
    ];
    const result = aggregateByScope(rows);
    expect(result[0]!.scope).toBe('project::lorekit');
    expect(result[1]!.scope).toBe('repo::x');
    expect(result[2]!.scope).toBe('global');
  });
});

// ── aggregateByDay ────────────────────────────────────────────────────────────

describe('aggregateByDay', () => {
  it('returns empty array for no rows', () => {
    expect(aggregateByDay([])).toEqual([]);
  });

  it('counts a single row as one entry', () => {
    const rows = [{ created_at: '2026-07-01T10:00:00Z' }];
    expect(aggregateByDay(rows)).toEqual([{ date: '2026-07-01', count: 1 }]);
  });

  it('groups multiple rows on the same day', () => {
    const rows = [
      { created_at: '2026-07-01T08:00:00Z' },
      { created_at: '2026-07-01T14:00:00Z' },
      { created_at: '2026-07-01T23:59:00Z' },
    ];
    const result = aggregateByDay(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '2026-07-01', count: 3 });
  });

  it('produces separate entries for different days', () => {
    const rows = [
      { created_at: '2026-07-01T10:00:00Z' },
      { created_at: '2026-07-02T10:00:00Z' },
      { created_at: '2026-07-01T11:00:00Z' },
    ];
    const result = aggregateByDay(rows);
    expect(result).toHaveLength(2);
    const jul1 = result.find((d) => d.date === '2026-07-01');
    expect(jul1?.count).toBe(2);
    const jul2 = result.find((d) => d.date === '2026-07-02');
    expect(jul2?.count).toBe(1);
  });

  it('sorts by date ascending', () => {
    const rows = [
      { created_at: '2026-07-05T10:00:00Z' },
      { created_at: '2026-07-01T10:00:00Z' },
      { created_at: '2026-07-03T10:00:00Z' },
    ];
    const result = aggregateByDay(rows);
    expect(result.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-03', '2026-07-05']);
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

// ── computeStatTrends ─────────────────────────────────────────────────────────

describe('computeStatTrends', () => {
  const NOW = '2026-07-24T12:00:00Z'; // Friday

  it('returns daily (30) and hourly (24) bucketed series', () => {
    const t = computeStatTrends([], NOW);
    expect(t.lessons.points).toHaveLength(30);
    expect(t.scopes.points).toHaveLength(30);
    expect(t.activity.points).toHaveLength(24);
    expect(t.lessons.points.every((p) => p.value === 0)).toBe(true);
    expect(t.lessons.changePct).toBe(0);
  });

  it('counts lessons per day and totals to the in-window count', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-24T10:00:00Z' }, // today
      { scope: 'project::a', created_at: '2026-07-24T11:00:00Z' }, // today
      { scope: 'project::a', created_at: '2026-07-23T09:00:00Z' }, // yesterday
    ];
    const t = computeStatTrends(rows, NOW);
    // Last bucket = today.
    expect(t.lessons.points[t.lessons.points.length - 1]!.value).toBe(2);
    expect(t.lessons.points[t.lessons.points.length - 2]!.value).toBe(1);
    const total = t.lessons.points.reduce((a, p) => a + p.value, 0);
    expect(total).toBe(3);
  });

  it('counts distinct scopes per day', () => {
    const rows = [
      { scope: 'global', created_at: '2026-07-24T10:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-24T11:00:00Z' },
      { scope: 'project::a', created_at: '2026-07-24T12:00:00Z' }, // dup scope same day
    ];
    const t = computeStatTrends(rows, NOW);
    expect(t.scopes.points[t.scopes.points.length - 1]!.value).toBe(2); // global + project::a
  });

  it('counts lessons per hour for the last 24h', () => {
    // NOW is 12:00 → last bucket is [12:00,13:00), which is empty here.
    const rows = [
      { scope: 'global', created_at: '2026-07-24T11:30:00Z' }, // 11:00 bucket
      { scope: 'global', created_at: '2026-07-24T10:15:00Z' }, // 10:00 bucket
    ];
    const t = computeStatTrends(rows, NOW);
    expect(t.activity.points).toHaveLength(24);
    const n = t.activity.points.length;
    expect(t.activity.points[n - 1]!.value).toBe(0); // 12:00
    expect(t.activity.points[n - 2]!.value).toBe(1); // 11:00
    expect(t.activity.points[n - 3]!.value).toBe(1); // 10:00
  });

  it('excludes rows older than the daily window', () => {
    const rows = [{ scope: 'global', created_at: '2026-01-01T10:00:00Z' }];
    const t = computeStatTrends(rows, NOW);
    expect(t.lessons.points.reduce((a, p) => a + p.value, 0)).toBe(0);
  });

  // ── scopes.changePct regression ───────────────────────────────────────────
  it('scopes.changePct uses window-distinct union, not sum of daily distinct counts', () => {
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
    const t = computeStatTrends(rows, NOW);
    expect(t.scopes.changePct).toBe(200);
  });

  it('scopes.changePct is 0 when the same scope set is active in both windows', () => {
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
    const t = computeStatTrends(rows, NOW);
    expect(t.scopes.changePct).toBe(0);
  });

  it('lessons.changePct sums counts correctly', () => {
    // Prior 7 days: 1 lesson/day = 7 total. Recent 7 days: 2 lessons/day = 14 total → +100%
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
    const t = computeStatTrends(rows, NOW);
    expect(t.lessons.changePct).toBe(100);
  });

  it('activity.changePct compares last 12 hours vs prior 12 hours', () => {
    // NOW = 12:00 UTC. Prior 12h = yesterday 12:00–23:59 (3 lessons). Recent 12h = today 00:00–11:59 (6 lessons) → +100%
    const rows = [
      { scope: 'global', created_at: '2026-07-23T14:00:00Z' },
      { scope: 'global', created_at: '2026-07-23T16:00:00Z' },
      { scope: 'global', created_at: '2026-07-23T20:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T01:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T03:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T05:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T07:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T09:00:00Z' },
      { scope: 'global', created_at: '2026-07-24T11:00:00Z' },
    ];
    const t = computeStatTrends(rows, NOW);
    expect(t.activity.changePct).toBe(100);
  });
});
