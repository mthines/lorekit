import { describe, it, expect } from 'vitest';
import { aggregateByScope, aggregateByDay, computeStatTrends, pctChange } from './aggregations';

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
});
