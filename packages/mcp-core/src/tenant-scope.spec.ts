import { describe, it, expect, vi } from 'vitest';
import { applyTenantScope, intersectTokenOrgIds } from './tenant-scope.js';

interface FakeQuery {
  eq: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
}

function fakeQuery(): FakeQuery {
  const query = {} as FakeQuery;
  query.eq = vi.fn().mockReturnValue(query);
  query.or = vi.fn().mockReturnValue(query);
  return query;
}

describe('applyTenantScope', () => {
  it('empty orgIds: returns a personal-only filter, never touching .or()', () => {
    const query = fakeQuery();
    const result = applyTenantScope(query, 'user-1', []);
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.or).not.toHaveBeenCalled();
    expect(result).toBe(query);
  });

  it('non-empty orgIds: widens to personal + member-org rows via one .or() filter', () => {
    const query = fakeQuery();
    const result = applyTenantScope(query, 'user-1', ['org-a', 'org-b']);
    expect(query.or).toHaveBeenCalledWith('user_id.eq.user-1,org_id.in.("org-a","org-b")');
    expect(query.eq).not.toHaveBeenCalled();
    expect(result).toBe(query);
  });

  it('single org id: emits a one-element org_id.in.() list', () => {
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a']);
    expect(query.or).toHaveBeenCalledWith('user_id.eq.user-1,org_id.in.("org-a")');
  });

  it('total function: an empty orgIds list never emits an org_id.in.() fragment', () => {
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', []);
    const orFragments = query.or.mock.calls.map((call) => call[0] as string);
    expect(orFragments.some((f) => f.includes('org_id.in.()'))).toBe(false);
  });
});

describe('intersectTokenOrgIds', () => {
  it('null allow-list: an unrestricted credential sees every membership', () => {
    // The pre-OAuth behaviour every personal dashboard token keeps — this is
    // what makes 00049 additive with no backfill.
    expect(intersectTokenOrgIds(null, ['org-a', 'org-b'])).toEqual(['org-a', 'org-b']);
    expect(intersectTokenOrgIds(undefined, ['org-a'])).toEqual(['org-a']);
  });

  it('empty allow-list is meaningful: personal lore only, not "unrestricted"', () => {
    expect(intersectTokenOrgIds([], ['org-a', 'org-b'])).toEqual([]);
  });

  it('narrows to the intersection', () => {
    expect(intersectTokenOrgIds(['org-b'], ['org-a', 'org-b'])).toEqual(['org-b']);
  });

  it('can never WIDEN: an org named by the token but not by membership is dropped', () => {
    // The security property. Membership stays the authority, so leaving an org
    // revokes access immediately even though the token still names it.
    expect(intersectTokenOrgIds(['org-a', 'org-ghost'], ['org-a'])).toEqual(['org-a']);
    expect(intersectTokenOrgIds(['org-ghost'], [])).toEqual([]);
  });

  it('preserves membership order so the emitted PostgREST filter is stable', () => {
    expect(intersectTokenOrgIds(['org-b', 'org-a'], ['org-a', 'org-b'])).toEqual(['org-a', 'org-b']);
  });
});
