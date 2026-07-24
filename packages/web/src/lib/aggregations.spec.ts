import { describe, it, expect } from 'vitest';
import { aggregateByScope, aggregateByDay } from './aggregations';

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
