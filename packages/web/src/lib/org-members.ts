'use server';

/**
 * Server action wrapping `lorekit_org_members_list` (00023_org_member_identities.sql)
 * — resolves real GitHub handles + avatars for an org's members. This is the
 * Phase 4 addition that reverses plan.md Decision D1's "no handle resolution
 * for other members" deferral (see
 * .agent/claude/org-sharing-phase-4-dashboard/plan.md Decisions, D1).
 *
 * Same authentication shape as orgs.ts/org-invites.ts: Supabase user JWT.
 * SECURITY DEFINER + membership-gated at the DB layer — this action adds no
 * authorization logic of its own, mirroring `listMembers` (orgs.ts).
 */

import { createServerClient } from '@/lib/supabase/server';
import type { OrgRole } from '@/lib/orgs';

export interface OrgMemberIdentity {
  user_id: string;
  handle: string | null;
  avatar_url: string | null;
  role: OrgRole;
  joined_at: string;
}

/**
 * List an org's members with resolved GitHub handle + avatar. Returns an
 * empty array for a caller who isn't a member of `orgId` — the RPC never
 * leaks membership of an org the caller doesn't belong to.
 */
export async function listMemberIdentities(orgId: string): Promise<OrgMemberIdentity[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase.rpc('lorekit_org_members_list', { p_org_id: orgId });
  if (error) {
    console.error('[listMemberIdentities] DB error:', error.message);
    return [];
  }
  return (data ?? []) as OrgMemberIdentity[];
}
