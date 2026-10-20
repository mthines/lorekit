import { describe, expect, it } from 'vitest';
import { memoryQuotaFromRow } from './memory-quota';

describe('memoryQuotaFromRow', () => {
  it('reports the personal pair the cap enforces, not the combined count', () => {
    // The RPC's `count` is personal + org (4300) but its `limit` is the
    // PERSONAL cap. Remaining must come from the personal count alone.
    const quota = memoryQuotaFromRow({ count: 4300, personal_count: 3318, org_count: 982, limit: 5000, plan: 'free' });

    expect(quota).toEqual({
      plan: 'free',
      personal: { count: 3318, limit: 5000, remaining: 1682 },
      org_count: 982,
      total: 4300,
    });
  });

  it('never reports negative headroom when a lowered limit sits under the count', () => {
    expect(memoryQuotaFromRow({ personal_count: 120, org_count: 0, limit: 100, plan: 'free' }).personal)
      .toEqual({ count: 120, limit: 100, remaining: 0 });
  });

  it('coerces the untyped jsonb fields (numeric strings, missing, junk)', () => {
    expect(memoryQuotaFromRow({ personal_count: '7', org_count: null, limit: '10', plan: 'team' })).toEqual({
      plan: 'team',
      personal: { count: 7, limit: 10, remaining: 3 },
      org_count: 0,
      total: 7,
    });
  });

  it('falls back to the free plan and zeros for an empty row', () => {
    expect(memoryQuotaFromRow(null)).toEqual({
      plan: 'free',
      personal: { count: 0, limit: 0, remaining: 0 },
      org_count: 0,
      total: 0,
    });
    expect(memoryQuotaFromRow({ plan: '  ' }).plan).toBe('free');
  });
});
