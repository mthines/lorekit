/**
 * Pure UI decision logic for the Organization dashboard surface (functional
 * core; the `.tsx` components are the impure shell — plan.md Decision D5).
 * Kept dependency-free and node-testable, mirroring `token-permission.ts`'s
 * single-record pattern (plan.md Decision D4).
 */

import type { OrgRole } from './orgs';
import type { OrgInvite } from './org-invites';

// ── Org deletion policy ──────────────────────────────────────────────────────

/**
 * How long a soft-deleted org (and its shared lore) is retained before it's
 * eligible for permanent purge. There is no automated purge job yet — this is
 * the documented intended window, surfaced in the delete confirmation copy so
 * an owner knows the delete is recoverable. `lorekit_org_purge` is the explicit
 * permanent-delete path (SQL-only for now, see 00025).
 *
 * Lives here (not in the `'use server'` `orgs.ts`) because a "use server" file
 * may only export async functions — a plain value export is a compile error.
 */
export const ORG_DELETE_RETENTION_DAYS = 30;

// ── Role → UI-affordance capability matrix ───────────────────────────────────

export interface OrgRoleCapabilities {
  canInvite: boolean;
  canManageRoles: boolean;
  canRemoveMembers: boolean;
  canRename: boolean;
  canDelete: boolean;
  /** Can bind/unbind scopes to this org (mirrors `manage_scopes` in lorekit_org_can). */
  canManageScopes: boolean;
}

/**
 * Single source of truth for which org actions a role's UI may offer. Mirrors
 * the `lorekit_org_can` capability matrix (00015/00020) exactly — 'invite',
 * 'change_role', and 'remove_member' are admin+owner; 'rename_org' is
 * admin+owner; 'delete_org' is owner-only. This is a UI-affordance mirror
 * ONLY: the RPC remains the sole authorization gate, never re-derived here.
 */
export const roleCapabilities: Record<OrgRole, OrgRoleCapabilities> = {
  owner:  { canInvite: true,  canManageRoles: true,  canRemoveMembers: true,  canRename: true,  canDelete: true,  canManageScopes: true },
  admin:  { canInvite: true,  canManageRoles: true,  canRemoveMembers: true,  canRename: true,  canDelete: false, canManageScopes: true },
  member: { canInvite: false, canManageRoles: false, canRemoveMembers: false, canRename: false, canDelete: false, canManageScopes: false },
  viewer: { canInvite: false, canManageRoles: false, canRemoveMembers: false, canRename: false, canDelete: false, canManageScopes: false },
};

/**
 * UI-affordance mirror of the admin-vs-owner invariant enforced
 * authoritatively by `lorekit_org_member_remove` / `lorekit_org_member_role`
 * (00020): an admin actor may act on member/viewer targets only, never on an
 * owner or another admin; an owner may act on anyone. Used to hide (not
 * gate — the RPC is the real gate) the remove/role-change affordance for a
 * target the actor could not actually act on.
 */
export function canActOnOrgMember(actorRole: OrgRole, targetRole: OrgRole): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'owner' && targetRole !== 'admin';
  return false;
}

// ── Ownership filter ─────────────────────────────────────────────────────────

export type OwnerFilter = 'all' | 'personal' | { orgId: string };

/**
 * Filters rows by ownership: 'all' returns everything, 'personal' returns
 * only rows with no org, and `{orgId}` returns only that org's rows.
 */
export function filterByOwnership<T extends { org?: { id: string } | null }>(
  rows: T[],
  filter: OwnerFilter,
): T[] {
  if (filter === 'all') return rows;
  if (filter === 'personal') return rows.filter((r) => !r.org);
  return rows.filter((r) => r.org?.id === filter.orgId);
}

// ── Invite input classification ──────────────────────────────────────────────

export interface ClassifiedInviteInput {
  kind: 'email' | 'handle' | 'empty';
  value: string;
}

/**
 * Classifies a raw invite-form input as an email, a GitHub handle, or empty.
 * Mirrors `inviteMember`'s own `trimmed.includes('@')` rule (org-invites.ts)
 * exactly, so client-side validation never disagrees with the server action.
 */
export function classifyInviteInput(raw: string): ClassifiedInviteInput {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { kind: 'empty', value: '' };
  return { kind: trimmed.includes('@') ? 'email' : 'handle', value: trimmed };
}

// ── Pending invite visibility (dismissal is local, per-browser) ─────────────

/** Pending invites not yet dismissed (by id) in this browser. */
export function visibleInvites(invites: OrgInvite[], dismissedIds: string[]): OrgInvite[] {
  const dismissed = new Set(dismissedIds);
  return invites.filter((invite) => invite.status === 'pending' && !dismissed.has(invite.id));
}

/** Count of undismissed pending invites — drives the Organization nav badge. */
export function pendingInviteCount(invites: OrgInvite[], dismissedIds: string[]): number {
  return visibleInvites(invites, dismissedIds).length;
}
