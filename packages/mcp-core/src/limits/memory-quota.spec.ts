import { describe, expect, it, vi } from 'vitest';
import type { KeyRestriction } from '../auth/tenant-scope';
import { memoryQuotaFromRow, quotaForKey, type MemoryQuota } from './memory-quota';

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

describe('quotaForKey', () => {
  // The owner belongs to three orgs holding 982 org memories between them.
  const OWNER_QUOTA: MemoryQuota = {
    plan: 'free',
    personal: { count: 3318, limit: 5000, remaining: 1682 },
    org_count: 982,
    total: 4300,
  };
  const MEMBER_ORGS = ['org-a', 'org-b', 'org-c'];

  function fakeReads(orgCount = 0) {
    return {
      memberOrgIds: vi.fn(async () => MEMBER_ORGS),
      countOrgMemories: vi.fn(async (_orgIds: string[]) => orgCount),
    };
  }
  const key = (orgAccess: KeyRestriction['orgAccess'], orgIds: string[] = []): KeyRestriction =>
    ({ scopes: [], orgAccess, orgIds });

  it('leaves a JWT or unrestricted caller on the owner figure, without reading anything', async () => {
    for (const k of [undefined, key('all')]) {
      const reads = fakeReads();
      await expect(quotaForKey(OWNER_QUOTA, k, reads)).resolves.toBe(OWNER_QUOTA);
      expect(reads.memberOrgIds).not.toHaveBeenCalled();
      expect(reads.countOrgMemories).not.toHaveBeenCalled();
    }
  });

  it('shows a personal-only key no org memories, and never counts any', async () => {
    const reads = fakeReads(982);
    const quota = await quotaForKey(OWNER_QUOTA, key('personal'), reads);

    expect(quota).toEqual({ ...OWNER_QUOTA, org_count: 0, total: 3318 });
    expect(reads.countOrgMemories).not.toHaveBeenCalled();
  });

  it('counts a selected-orgs key over its orgs that the owner still belongs to', async () => {
    // `org-gone` is a stale allowlist entry: the owner has since left that org.
    const reads = fakeReads(140);
    const quota = await quotaForKey(OWNER_QUOTA, key('selected', ['org-b', 'org-gone']), reads);

    expect(reads.countOrgMemories).toHaveBeenCalledWith(['org-b']);
    expect(quota).toEqual({ ...OWNER_QUOTA, org_count: 140, total: 3458 });
  });

  it('never narrows the personal pair, whatever the scope allowlist', async () => {
    const scoped: KeyRestriction = { scopes: ['repo::acme/api'], orgAccess: 'personal', orgIds: [] };
    const quota = await quotaForKey(OWNER_QUOTA, scoped, fakeReads());

    expect(quota.personal).toEqual(OWNER_QUOTA.personal);
  });

  it('skips the count when a selected key reaches none of the owner\'s orgs', async () => {
    const reads = fakeReads(982);
    const quota = await quotaForKey(OWNER_QUOTA, key('selected', ['org-gone']), reads);

    expect(quota).toEqual({ ...OWNER_QUOTA, org_count: 0, total: 3318 });
    expect(reads.countOrgMemories).not.toHaveBeenCalled();
  });

  it('never reports more org memories than the owner figure, and coerces junk to 0', async () => {
    const above = await quotaForKey(OWNER_QUOTA, key('selected', ['org-a']), fakeReads(5000));
    expect(above).toEqual({ ...OWNER_QUOTA, org_count: 982, total: 4300 });

    const junk = await quotaForKey(OWNER_QUOTA, key('selected', ['org-a']), fakeReads(Number.NaN));
    expect(junk).toEqual({ ...OWNER_QUOTA, org_count: 0, total: 3318 });
  });

  it('rejects when a read fails instead of falling back to the owner figure', async () => {
    const reads = fakeReads();
    reads.countOrgMemories.mockRejectedValueOnce(new Error('db down'));

    await expect(quotaForKey(OWNER_QUOTA, key('selected', ['org-a']), reads)).rejects.toThrow('db down');
  });
});
