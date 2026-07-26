import { describe, it, expect, vi } from 'vitest';
import { applyTenantScope } from './tenant-scope.js';

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
