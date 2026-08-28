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
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';
import { sendInviteEmail } from '@/lib/invite-email';
import type { OrgRole } from '@/lib/orgs';
import { withSpan, logger, SpanStatusCode } from '@/lib/telemetry';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

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
  /**
   * Embedded org name/slug (PostgREST join via `org_invites.org_id ->
   * orgs.id`, no new RPC/migration) — the Overview pending-invite banner
   * needs the org's name ("invited you to Acme Team"), which the bare
   * `org_id` alone can't render. Undefined if the embed can't resolve.
   */
  org?: { name: string; slug: string } | null;
}

/**
 * Tier-A org details a PENDING (non-member) invitee may see before
 * accepting — resolved server-side by `lorekit_invite_org_details` (00028),
 * gated on `lorekit_invite_addressed_to_caller`. Deliberately excludes any
 * per-member identity list (Tier B, declined in Phase 0).
 */
export interface InviteOrgDetails {
  org_name: string;
  org_slug: string;
  org_created_at: string;
  member_count: number;
  inviter_handle: string | null;
  inviter_avatar_url: string | null;
}

/** Narrows a raw PostgREST row (embedded `orgs` relation) into an OrgInvite. */
function mapInviteRow(row: Record<string, unknown>): OrgInvite {
  const orgEmbed = row.orgs as { name: string; slug: string } | null | undefined;
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    invitee_email: row.invitee_email as string | null,
    invitee_handle: row.invitee_handle as string | null,
    role: row.role as Exclude<OrgRole, 'owner'>,
    status: row.status as OrgInviteStatus,
    invited_by: row.invited_by as string | null,
    created_at: row.created_at as string,
    responded_at: row.responded_at as string | null,
    expires_at: row.expires_at as string | null,
    org: orgEmbed ? { name: orgEmbed.name, slug: orgEmbed.slug } : null,
  };
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
  /**
   * The org's display name, for the invite email subject. The dashboard call
   * site already has it in state, so passing it here skips a DB round-trip. When
   * omitted (or blank), it's resolved from the DB, then falls back to slug /
   * generic — the email is never blocked on the name.
   */
  orgName?: string,
): Promise<{ inviteId: string } | { error: string }> {
  return withSpan(
    'lorekit.org.invite.member',
    {
      // Bounded, non-PII attributes safe for span dimensions.
      // org_id (UUID) is safe — not a user-identifying string.
      'lorekit.org.id': orgId,
      'lorekit.invite.role': role,
    },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };

      const trimmed = handleOrEmail.trim().toLowerCase();
      if (!trimmed) return { error: 'An email or GitHub handle is required' };
      const isEmail = trimmed.includes('@');

      // Distinguish email vs handle invites — useful for diagnosing email delivery gaps.
      span.setAttribute('lorekit.invite.type', isEmail ? 'email' : 'handle');

      const { data: inviteId, error } = await supabase.rpc('lorekit_org_invite', {
        p_org_id: orgId,
        p_invitee_email: isEmail ? trimmed : null,
        p_invitee_handle: isEmail ? null : trimmed,
        p_role: role,
      });

      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `SupabaseRpcError: ${error.message}`,
        });
        logger.error('lorekit.org.invite.member.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.id': orgId,
          'lorekit.invite.role': role,
          'lorekit.invite.type': isEmail ? 'email' : 'handle',
        });
        return { error: error.message };
      }

      span.setAttribute('lorekit.invite.id', inviteId as string);

      await recordAuditEvent({
        action: 'member.invite',
        resourceType: 'org_invite',
        resourceId: inviteId as string,
        target: orgId,
        metadata: { invitee: trimmed, role },
      });

      // Fire the notification email for email invites only (a handle-only invite
      // has no address). Non-blocking and non-throwing — sendInviteEmail swallows
      // every failure, so a bad key / unverified domain never breaks the invite
      // that already succeeded above. Prefer the caller-supplied org name; only
      // hit the DB when it wasn't passed.
      if (isEmail) {
        let resolvedName = orgName?.trim() ?? '';
        if (!resolvedName) {
          const { data: org } = await supabase
            .from('orgs')
            .select('name, slug')
            .eq('id', orgId)
            .maybeSingle();
          resolvedName = org?.name ?? org?.slug ?? 'your organization';
        }
        const invitedByLabel =
          (user.user_metadata?.user_name as string | undefined) ?? user.email ?? null;
        await sendInviteEmail({ to: trimmed, orgName: resolvedName, role, invitedByLabel });
      }

      revalidatePath('/settings', 'layout');
      return { inviteId: inviteId as string };
    },
  );
}

/** List an org's invites (all statuses). Owner/admin visibility via RLS. */
export async function listInvites(orgId: string): Promise<OrgInvite[]> {
  const supabase = await createServerClient();
  const user = await getVerifiedUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('org_invites')
    .select('id, org_id, invitee_email, invitee_handle, role, status, invited_by, created_at, responded_at, expires_at, orgs(name, slug)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('lorekit.org.list_invites.failed', {
      'exception.type': 'SupabaseQueryError',
      'exception.message': error.message,
      'lorekit.org.id': orgId,
    });
    return [];
  }
  return (data ?? []).map((row) => mapInviteRow(row as Record<string, unknown>));
}

/** Revoke a pending invite. Owner/admin only. */
export async function revokeInvite(inviteId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.invite.revoke',
    { 'lorekit.invite.id': inviteId },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_invite_revoke', { p_invite_id: inviteId });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `SupabaseRpcError: ${error.message}`,
        });
        logger.error('lorekit.org.invite.revoke.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.invite.id': inviteId,
        });
        return { error: error.message };
      }

      await recordAuditEvent({ action: 'member.revoke', resourceType: 'org_invite', resourceId: inviteId });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/**
 * Accept a pending invite addressed to the caller's verified identity. Binds
 * the new membership row to auth.uid() — see the module doc comment.
 */
export async function acceptInvite(inviteId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.invite.accept',
    { 'lorekit.invite.id': inviteId },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_invite_accept', { p_invite_id: inviteId });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `SupabaseRpcError: ${error.message}`,
        });
        logger.error('lorekit.org.invite.accept.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.invite.id': inviteId,
        });
        return { error: error.message }; // LK002 message surfaced as-is
      }

      await recordAuditEvent({ action: 'member.accept', resourceType: 'org_invite', resourceId: inviteId });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/** Decline a pending invite addressed to the caller. Creates no membership. */
export async function declineInvite(inviteId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.invite.decline',
    { 'lorekit.invite.id': inviteId },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_invite_decline', { p_invite_id: inviteId });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `SupabaseRpcError: ${error.message}`,
        });
        logger.error('lorekit.org.invite.decline.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.invite.id': inviteId,
        });
        return { error: error.message };
      }

      await recordAuditEvent({ action: 'member.decline', resourceType: 'org_invite', resourceId: inviteId });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/**
 * Fetch Tier-A org details for a pending invite addressed to the caller's
 * verified identity — lets a not-yet-member invitee see WHICH org invited
 * them (name, slug, inviter, member count) before accepting. Wraps
 * `lorekit_invite_org_details` (00028), which returns an EMPTY set (never an
 * error) for an invite that doesn't exist, isn't pending, or isn't addressed
 * to the caller — so this is a total function: `null` covers every
 * absent-by-design case, matching `getOrg`'s null-on-absence shape (orgs.ts).
 */
export async function getInviteOrgDetails(inviteId: string): Promise<InviteOrgDetails | null> {
  const supabase = await createServerClient();
  const user = await getVerifiedUser();
  if (!user) return null;

  const { data, error } = await supabase.rpc('lorekit_invite_org_details', { p_invite_id: inviteId });
  if (error) {
    logger.error('lorekit.org.invite.get_org_details.failed', {
      'exception.type': 'SupabaseRpcError',
      'exception.message': error.message,
      'lorekit.invite.id': inviteId,
    });
    return null;
  }

  const row = (data as InviteOrgDetails[] | null)?.[0];
  return row ?? null;
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
  const user = await getVerifiedUser();
  if (!user) return [];

  const email = user.email?.toLowerCase();
  const handle = (user.user_metadata?.user_name as string | undefined)?.toLowerCase();
  if (!email && !handle) return [];

  // Double-quote the interpolated identity values so a comma (or other
  // PostgREST reserved char) in the value can't split the `.or()` string into
  // extra clauses — quoted values are parsed as literals. Non-exploitable
  // given the invitee-scoped RLS, but removes the parse ambiguity entirely.
  const identityFilters = [
    email ? `invitee_email.eq."${email}"` : null,
    handle ? `invitee_handle.eq."${handle}"` : null,
  ].filter((f): f is string => f !== null);

  const { data, error } = await supabase
    .from('org_invites')
    .select('id, org_id, invitee_email, invitee_handle, role, status, invited_by, created_at, responded_at, expires_at, orgs(name, slug)')
    .eq('status', 'pending')
    .or(identityFilters.join(','));

  if (error) {
    logger.error('lorekit.org.list_pending_invites.failed', {
      'exception.type': 'SupabaseQueryError',
      'exception.message': error.message,
    });
    return [];
  }
  return (data ?? []).map((row) => mapInviteRow(row as Record<string, unknown>));
}
