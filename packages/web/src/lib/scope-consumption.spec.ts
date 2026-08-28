import { describe, it, expect } from 'vitest';
import type { ReadActivityBucket } from '@lorekit/schemas/memory';
import { rankScopeConsumption } from './scope-consumption';

function bucket(scope: string | null, count: number, at = '2026-08-01T00:00:00.000Z'): ReadActivityBucket {
  return { bucket: at, scope, count };
}

describe('rankScopeConsumption', () => {
  it('sums records per scope across multiple buckets', () => {
    const { rows } = rankScopeConsumption([
      bucket('repo::mthines/lorekit', 100, '2026-08-01T00:00:00.000Z'),
      bucket('repo::mthines/lorekit', 50, '2026-08-02T00:00:00.000Z'),
      bucket('global', 30),
    ]);
    expect(rows).toEqual([
      { scope: 'repo::mthines/lorekit', count: 150 },
      { scope: 'global', count: 30 },
    ]);
  });

  it('ranks descending by count', () => {
    const { rows } = rankScopeConsumption([bucket('a', 5), bucket('b', 50), bucket('c', 20)]);
    expect(rows.map((r) => r.scope)).toEqual(['b', 'c', 'a']);
  });

  it('keeps the null (unattributed) bucket as its own row rather than dropping it', () => {
    const { rows } = rankScopeConsumption([bucket('global', 10), bucket(null, 40)]);
    expect(rows).toContainEqual({ scope: null, count: 40 });
  });

  it('total sums every row, including the unattributed bucket', () => {
    const { rows, total } = rankScopeConsumption([bucket('global', 10), bucket(null, 40), bucket('repo::a/b', 5)]);
    expect(total).toBe(55);
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(total);
  });

  it('returns an empty ranking for no buckets', () => {
    expect(rankScopeConsumption([])).toEqual({ rows: [], total: 0 });
  });
});
