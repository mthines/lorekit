'use server';

/**
 * Server actions for the invite lifecycle (invite / list / revoke / accept /
 * decline / list-pending-for-me).
 *
 * Same authentication shape as orgs.ts: Supabase user JWT + RLS reads, RPC
 * writes. `acceptInvite` is the security-critical path — it calls
 * `lorekit_org_invite_accept(p_invite_id)`, which takes NO user-id parameter
 * and binds the new membership row to the CALLER's `auth.uid()` inside the
 * SECURITY DEFINER function, never to the invited email/handle string (the
 * anti-TOCTOU fix — see plan.md). This server action does not (and must not)
 * pass any identity of its own; the RPC derives it from the request's JWT.
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';
import type { OrgRole } from '@/lib/orgs';

export type OrgInviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface OrgInvite {
  id: string;
  org_id: string;
  invitee_email: string | null;
  invitee_handle: string | null;
  role: Exclude<OrgRole, 'owner'>;
  status: OrgInviteStatus;
  invited_by: string | null;
  created_at: string;
  responded_at: string | null;
  expires_at: string | null;
}

/**
 * Invite a teammate by email or GitHub handle. Owner/admin only
 * (lorekit_org_invite enforces via lorekit_org_can 'invite'); the
 * org_invites.role CHECK independently rejects an attempt to invite an
 * 'owner'.
 */
export async function inviteMember(
  orgId: string,
  handleOrEmail: string,
  role: Exclude<OrgRole, 'owner'>,
): Promise<{ inviteId: string } | { error: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const trimmed = handleOrEmail.trim().toLowerCase();
  if (!trimmed) return { error: 'An email or GitHub handle is required' };
  const isEmail = trimmed.includes('@');

  const { data: inviteId, error } = await supabase.rpc('lorekit_org_invite', {
    p_org_id: orgId,
    p_invitee_email: isEmail ? trimmed : null,
    p_invitee_handle: isEmail ? null : trimmed,
    p_role: role,
  });
  if (error) return { error: error.message };

  await recordAuditEvent({
    action: 'member.invite',
    resourceType: 'org_invite',
    resourceId: inviteId as string,
    target: orgId,
    metadata: { invitee: trimmed, role },
  });
  revalidatePath('/settings', 'layout');
  return { inviteId: inviteId as string };
}

/** List an org's invites (all statuses). Owner/admin visibility via RLS. */
export async function listInvites(orgId: string): Promise<OrgInvite[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('org_invites')
    .select('id, org_id, invitee_email, invitee_handle, role, status, invited_by, created_at, responded_at, expires_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[listInvites] DB error:', error.message);
    return [];
  }
  return (data ?? []) as OrgInvite[];
}

/** Revoke a pending invite. Owner/admin only. */
export async function revokeInvite(inviteId: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { error } = await supabase.rpc('lorekit_org_invite_revoke', { p_invite_id: inviteId });
  if (error) return { error: error.message };

  await recordAuditEvent({ action: 'member.revoke', resourceType: 'org_invite', resourceId: inviteId });
  revalidatePath('/settings', 'layout');
  return {};
}

/**
 * Accept a pending invite addressed to the caller's verified identity. Binds
 * the new membership row to auth.uid() — see the module doc comment.
 */
export async function acceptInvite(inviteId: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { error } = await supabase.rpc('lorekit_org_invite_accept', { p_invite_id: inviteId });
  if (error) return { error: error.message }; // LK002 message surfaced as-is

  await recordAuditEvent({ action: 'member.accept', resourceType: 'org_invite', resourceId: inviteId });
  revalidatePath('/settings', 'layout');
  return {};
}

/** Decline a pending invite addressed to the caller. Creates no membership. */
export async function declineInvite(inviteId: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { error } = await supabase.rpc('lorekit_org_invite_decline', { p_invite_id: inviteId });
  if (error) return { error: error.message };

  await recordAuditEvent({ action: 'member.decline', resourceType: 'org_invite', resourceId: inviteId });
  revalidatePath('/settings', 'layout');
  return {};
}

/**
 * List pending invites addressed to the current user's verified identity
 * (email or GitHub handle). RLS's invitee policy (00019) already scopes
 * `org_invites` reads to invites addressed to the caller OR orgs they
 * manage — this explicitly filters to "addressed to me" so a manager's own
 * pending-invite banner doesn't pick up invites they merely administer.
 */
export async function listPendingInvitesForMe(): Promise<OrgInvite[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const email = user.email?.toLowerCase();
  const handle = (user.user_metadata?.user_name as string | undefined)?.toLowerCase();
  if (!email && !handle) return [];

  const identityFilters = [
    email ? `invitee_email.eq.${email}` : null,
    handle ? `invitee_handle.eq.${handle}` : null,
  ].filter((f): f is string => f !== null);

  const { data, error } = await supabase
    .from('org_invites')
    .select('id, org_id, invitee_email, invitee_handle, role, status, invited_by, created_at, responded_at, expires_at')
    .eq('status', 'pending')
    .or(identityFilters.join(','));

  if (error) {
    console.error('[listPendingInvitesForMe] DB error:', error.message);
    return [];
  }
  return (data ?? []) as OrgInvite[];
}
