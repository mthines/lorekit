import { describe, it, expect } from 'vitest';
import {
  roleCapabilities,
  canActOnOrgMember,
  filterByOwnership,
  classifyInviteInput,
  visibleInvites,
  pendingInviteCount,
  type OwnerFilter,
} from './org-ui';
import type { OrgInvite } from './org-invites';

describe('roleCapabilities', () => {
  it('viewer has no management capabilities', () => {
    expect(roleCapabilities.viewer).toEqual({
      canInvite: false, canManageRoles: false, canRemoveMembers: false, canRename: false, canDelete: false,
    });
  });

  it('member has no management capabilities (read+write lore, not org management)', () => {
    expect(roleCapabilities.member).toEqual({
      canInvite: false, canManageRoles: false, canRemoveMembers: false, canRename: false, canDelete: false,
    });
  });

  it('admin can invite, manage roles, remove members, and rename — but not delete', () => {
    expect(roleCapabilities.admin).toEqual({
      canInvite: true, canManageRoles: true, canRemoveMembers: true, canRename: true, canDelete: false,
    });
  });

  it('owner can do everything, including delete', () => {
    expect(roleCapabilities.owner).toEqual({
      canInvite: true, canManageRoles: true, canRemoveMembers: true, canRename: true, canDelete: true,
    });
  });
});

describe('canActOnOrgMember', () => {
  it('an owner can act on any target role', () => {
    expect(canActOnOrgMember('owner', 'owner')).toBe(true);
    expect(canActOnOrgMember('owner', 'admin')).toBe(true);
    expect(canActOnOrgMember('owner', 'member')).toBe(true);
    expect(canActOnOrgMember('owner', 'viewer')).toBe(true);
  });

  it('an admin can act on member/viewer targets only', () => {
    expect(canActOnOrgMember('admin', 'member')).toBe(true);
    expect(canActOnOrgMember('admin', 'viewer')).toBe(true);
  });

  it('an admin cannot act on an owner or another admin', () => {
    expect(canActOnOrgMember('admin', 'owner')).toBe(false);
    expect(canActOnOrgMember('admin', 'admin')).toBe(false);
  });

  it('a member or viewer cannot act on anyone', () => {
    expect(canActOnOrgMember('member', 'viewer')).toBe(false);
    expect(canActOnOrgMember('viewer', 'member')).toBe(false);
  });
});

describe('filterByOwnership', () => {
  const rows = [
    { id: 'a', org: undefined },
    { id: 'b', org: { id: 'org-1' } },
    { id: 'c', org: { id: 'org-2' } },
    { id: 'd', org: null },
  ];

  it("'all' returns every row unchanged", () => {
    expect(filterByOwnership(rows, 'all')).toEqual(rows);
  });

  it("'personal' returns only rows with no org", () => {
    expect(filterByOwnership(rows, 'personal').map((r) => r.id)).toEqual(['a', 'd']);
  });

  it('a specific org filter returns only that org\'s rows', () => {
    const filter: OwnerFilter = { orgId: 'org-1' };
    expect(filterByOwnership(rows, filter).map((r) => r.id)).toEqual(['b']);
  });

  it('a specific org filter with no matches returns an empty array', () => {
    const filter: OwnerFilter = { orgId: 'org-nonexistent' };
    expect(filterByOwnership(rows, filter)).toEqual([]);
  });
});

describe('classifyInviteInput', () => {
  it('classifies an email address', () => {
    expect(classifyInviteInput('Octocat@Example.com')).toEqual({ kind: 'email', value: 'octocat@example.com' });
  });

  it('classifies a bare GitHub handle', () => {
    expect(classifyInviteInput('  Octocat  ')).toEqual({ kind: 'handle', value: 'octocat' });
  });

  it('classifies empty or whitespace-only input as empty', () => {
    expect(classifyInviteInput('')).toEqual({ kind: 'empty', value: '' });
    expect(classifyInviteInput('   ')).toEqual({ kind: 'empty', value: '' });
  });
});

describe('visibleInvites / pendingInviteCount', () => {
  const invites: OrgInvite[] = [
    { id: '1', org_id: 'o', invitee_email: 'a@x.com', invitee_handle: null, role: 'member', status: 'pending', invited_by: null, created_at: '', responded_at: null, expires_at: null },
    { id: '2', org_id: 'o', invitee_email: 'b@x.com', invitee_handle: null, role: 'member', status: 'pending', invited_by: null, created_at: '', responded_at: null, expires_at: null },
    { id: '3', org_id: 'o', invitee_email: 'c@x.com', invitee_handle: null, role: 'member', status: 'accepted', invited_by: null, created_at: '', responded_at: null, expires_at: null },
  ];

  it('visibleInvites excludes dismissed ids and non-pending invites', () => {
    expect(visibleInvites(invites, ['1']).map((i) => i.id)).toEqual(['2']);
  });

  it('visibleInvites returns all pending invites when nothing is dismissed', () => {
    expect(visibleInvites(invites, []).map((i) => i.id)).toEqual(['1', '2']);
  });

  it('pendingInviteCount matches visibleInvites length', () => {
    expect(pendingInviteCount(invites, [])).toBe(2);
    expect(pendingInviteCount(invites, ['1', '2'])).toBe(0);
  });
});
