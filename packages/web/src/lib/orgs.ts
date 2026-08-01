'use server';

/**
 * Server actions for org lifecycle + membership management.
 *
 * Authenticated by the Supabase user JWT (createServerClient() +
 * auth.getUser(), the tokens.ts / webhook-secrets.ts pattern) — NOT an
 * MCP API-key bearer token. That auth tier (CLAUDE.md) applies to MCP
 * `api_key` tool calls, not dashboard server actions.
 *
 * READS are plain RLS-scoped `.select()`s (listMyOrgs, getOrg, listMembers) —
 * visibility is already governed by the `rls_orgs_select` /
 * `rls_org_members_select` policies (00012/00019), so there is no
 * authorization subtlety beyond what RLS already enforces.
 *
 * WRITES call the SECURITY DEFINER RPCs from 00022_org_management_rpcs.sql
 * (`lorekit_org_create`/`_rename`/`_delete`/`_member_remove`/`_member_role`/
 * `_leave`) — org_members/orgs carry NO insert/update/delete RLS policy, so a
 * direct `.insert()/.update()/.delete()` here would always fail. The RPC is
 * the sole authorization gate (`lorekit_org_can`), mirroring memory_write /
 * memory_delete (Phase 2). On success, each write calls the non-throwing
 * `recordAuditEvent` and revalidates '/settings'.
 *
 * Invite lifecycle lives in the sibling `org-invites.ts` (same read/write
 * split, same authentication shape).
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';
import { normalizeSlug } from '@/lib/org-slug';
import { withSpan, logger, SpanStatusCode } from '@/lib/telemetry';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Org {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface OrgMembership extends Org {
  role: OrgRole;
}

export interface OrgMember {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
}

/**
 * The org-deletion retention window (`ORG_DELETE_RETENTION_DAYS`) lives in the
 * pure `org-ui.ts` module, not here: a `'use server'` file may only export
 * async functions, so a plain value export is a compile error.
 */

/** A single org-owned memory row, shaped for the pre-delete JSON export. */
export interface MemoryExportRow {
  scope: string;
  key: string;
  value: string;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  source_agent: string | null;
  trigger: string | null;
}

/** Create an org; the caller becomes its owner. Returns the new org's id. */
export async function createOrg(slug: string, name: string): Promise<{ orgId: string } | { error: string }> {
  return withSpan(
    'lorekit.org.create',
    { 'lorekit.org.slug': slug },
    async (span) => {
      const supabase = await createServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: 'Not authenticated' };
      if (!name.trim()) return { error: 'Organization name is required' };

      const normalizedSlug = normalizeSlug(slug);
      if (!normalizedSlug) {
        return { error: 'Invalid organization slug — use 2–48 lowercase letters, digits, or dashes.' };
      }

      const { data: orgId, error } = await supabase.rpc('lorekit_org_create', {
        p_slug: normalizedSlug,
        p_name: name.trim(),
      });

      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseRpcError: ${error.message}` });
        logger.error('lorekit.org.create.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.slug': normalizedSlug,
        });
        return { error: error.message };
      }

      span.setAttribute('lorekit.org.id', orgId as string);

      await recordAuditEvent({
        action: 'org.create',
        resourceType: 'org',
        resourceId: orgId as string,
        target: name.trim(),
        metadata: { slug: normalizedSlug },
      });

      revalidatePath('/settings', 'layout');
      return { orgId: orgId as string };
    },
  );
}

/** List the orgs the current user is a member of, with their role in each. */
export async function listMyOrgs(): Promise<OrgMembership[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('org_members')
    .select('role, orgs (id, slug, name, created_at)')
    .eq('user_id', user.id);

  if (error) {
    logger.error('lorekit.org.list_my_orgs.failed', {
      'exception.type': 'SupabaseQueryError',
      'exception.message': error.message,
    });
    return [];
  }

  return (data ?? []).flatMap((row) => {
    const org = row.orgs as unknown as Org | null;
    if (!org) return [];
    return [{ ...org, role: row.role as OrgRole }];
  });
}

/** Fetch a single org by id. RLS-scoped — returns null if not a member. */
export async function getOrg(orgId: string): Promise<Org | null> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('orgs')
    .select('id, slug, name, created_at')
    .eq('id', orgId)
    .maybeSingle();

  if (error) {
    logger.error('lorekit.org.get.failed', {
      'exception.type': 'SupabaseQueryError',
      'exception.message': error.message,
      'lorekit.org.id': orgId,
    });
    return null;
  }
  return data as Org | null;
}

/** Rename an org. Owner/admin only (lorekit_org_can 'rename_org'). */
export async function renameOrg(orgId: string, name: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.rename',
    { 'lorekit.org.id': orgId },
    async (span) => {
      const supabase = await createServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: 'Not authenticated' };
      if (!name.trim()) return { error: 'Organization name is required' };

      const { error } = await supabase.rpc('lorekit_org_rename', { p_org_id: orgId, p_name: name.trim() });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseRpcError: ${error.message}` });
        logger.error('lorekit.org.rename.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.id': orgId,
        });
        return { error: error.message };
      }

      await recordAuditEvent({ action: 'org.rename', resourceType: 'org', resourceId: orgId, target: name.trim() });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/**
 * Soft-delete an org. Owner only. Since 00025 `lorekit_org_delete` stamps
 * `orgs.deleted_at` instead of removing the row: the org and its shared lore
 * immediately disappear from every member's reads (via the widened
 * `lorekit_member_org_ids`), but the data is retained and recoverable for
 * `ORG_DELETE_RETENTION_DAYS`. Permanent removal is the separate
 * `lorekit_org_purge` path (not wired to the dashboard yet).
 */
export async function deleteOrg(orgId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.delete',
    { 'lorekit.org.id': orgId },
    async (span) => {
      const supabase = await createServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_delete', { p_org_id: orgId });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseRpcError: ${error.message}` });
        logger.error('lorekit.org.delete.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.id': orgId,
        });
        return { error: error.message };
      }

      await recordAuditEvent({ action: 'org.delete', resourceType: 'org', resourceId: orgId });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/**
 * Hard cap on rows returned by a single {@link exportOrgLore} call. Bounds the
 * payload so a very large org can't produce a multi-MB response that times out
 * the action or exhausts client memory. An org at the cap is an edge case
 * (memory caps are far lower by default); if it's ever hit, `truncated` tells
 * the caller the export is partial.
 *
 * Not exported: it's used only by {@link exportOrgLore} below, and a
 * `'use server'` file may export async functions only — a value export is a
 * compile error.
 */
const ORG_EXPORT_ROW_LIMIT = 5000;

/**
 * Export an org's shared lore as rows for a client-side JSON download, offered
 * before deletion so an owner can keep a copy. RLS-scoped: only a member of the
 * org gets rows back (both the active and archived read policies match org rows
 * for members, so this returns the full set). Bounded to {@link
 * ORG_EXPORT_ROW_LIMIT} rows — `truncated` is true if more exist. Read-only.
 */
export async function exportOrgLore(
  orgId: string,
): Promise<{ rows: MemoryExportRow[]; truncated: boolean } | { error: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // Fetch one past the cap so we can tell the caller the export was truncated
  // without a separate count query.
  const { data, error } = await supabase
    .from('memories')
    // Provenance is part of what makes an exported lesson auditable later —
    // this is the last-chance copy taken before an org is deleted, so it must
    // not be the one artifact that drops where each lesson came from.
    .select(
      'scope, key, value, tags, created_at, updated_at, archived_at, source_agent, trigger, origin_repo, origin_branch, origin_commit, origin_pr',
    )
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })
    .limit(ORG_EXPORT_ROW_LIMIT + 1);

  if (error) return { error: error.message };
  const all = (data ?? []) as MemoryExportRow[];
  const truncated = all.length > ORG_EXPORT_ROW_LIMIT;
  return { rows: truncated ? all.slice(0, ORG_EXPORT_ROW_LIMIT) : all, truncated };
}

/**
 * List all co-members of an org. RLS (`rls_org_members_select`, widened in
 * 00019) scopes this to orgs the caller belongs to.
 */
export async function listMembers(orgId: string): Promise<OrgMember[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('org_members')
    .select('org_id, user_id, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('lorekit.org.list_members.failed', {
      'exception.type': 'SupabaseQueryError',
      'exception.message': error.message,
      'lorekit.org.id': orgId,
    });
    return [];
  }
  return (data ?? []) as OrgMember[];
}

/**
 * Remove a member from an org. Owner/admin only; an admin cannot remove an
 * owner or another admin; the last owner cannot be removed
 * (lorekit_org_member_remove enforces both invariants).
 */
export async function removeMember(orgId: string, targetUserId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.member.remove',
    { 'lorekit.org.id': orgId },
    async (span) => {
      const supabase = await createServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_member_remove', {
        p_org_id: orgId,
        p_target_user_id: targetUserId,
      });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseRpcError: ${error.message}` });
        logger.error('lorekit.org.member.remove.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.id': orgId,
        });
        return { error: error.message };
      }

      await recordAuditEvent({ action: 'member.remove', resourceType: 'org_member', resourceId: targetUserId, target: orgId });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/**
 * Change a member's role. Owner/admin only; cannot assign 'owner'; cannot
 * demote the last owner (lorekit_org_member_role enforces both invariants).
 */
export async function changeMemberRole(
  orgId: string,
  targetUserId: string,
  role: Exclude<OrgRole, 'owner'>,
): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.member.change_role',
    {
      'lorekit.org.id': orgId,
      'lorekit.org.member.role': role,
    },
    async (span) => {
      const supabase = await createServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_member_role', {
        p_org_id: orgId,
        p_target_user_id: targetUserId,
        p_role: role,
      });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseRpcError: ${error.message}` });
        logger.error('lorekit.org.member.change_role.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.id': orgId,
          'lorekit.org.member.role': role,
        });
        return { error: error.message };
      }

      await recordAuditEvent({
        action: 'member.role_change',
        resourceType: 'org_member',
        resourceId: targetUserId,
        target: orgId,
        metadata: { role },
      });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/** Leave an org (remove the caller's own membership). The last owner cannot leave. */
export async function leaveOrg(orgId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.org.leave',
    { 'lorekit.org.id': orgId },
    async (span) => {
      const supabase = await createServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: 'Not authenticated' };

      const { error } = await supabase.rpc('lorekit_org_leave', { p_org_id: orgId });
      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseRpcError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseRpcError: ${error.message}` });
        logger.error('lorekit.org.leave.failed', {
          'exception.type': 'SupabaseRpcError',
          'exception.message': error.message,
          'lorekit.org.id': orgId,
        });
        return { error: error.message };
      }

      await recordAuditEvent({ action: 'member.leave', resourceType: 'org_member', resourceId: user.id, target: orgId });
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}
