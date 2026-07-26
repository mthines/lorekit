'use server';

/**
 * Server actions for the scope → org binding lifecycle (bind / unbind / list).
 *
 * Same authentication shape as orgs.ts and org-invites.ts: Supabase user JWT
 * + RLS reads, `.rpc()` writes, non-throwing `recordAuditEvent`,
 * `revalidatePath('/settings','layout')`.
 *
 * The binding backend (lorekit_scope_bind / lorekit_scope_unbind) and the
 * `org_scope_bindings` table were shipped in 00026_scope_org_bindings.sql
 * (#114). This file is the UI / server-action layer only.
 *
 * Error translation:
 *  - SQLSTATE P0001, message starting with `scope_bound_elsewhere:` → friendly
 *    "This scope is already bound to another organization."
 *  - SQLSTATE LK002 (org_permission_denied) → "Only admins and owners can
 *    manage shared scopes."
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';

export interface ScopeBinding {
  id: string;
  org_id: string;
  scope: string;
  created_by: string | null;
  created_at: string;
}

/**
 * List the scope bindings for the given org. RLS (`rls_scope_bindings_select`)
 * scopes the read to orgs the caller is a member of.
 */
export async function listScopeBindings(orgId: string): Promise<ScopeBinding[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('org_scope_bindings')
    .select('id, org_id, scope, created_by, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[listScopeBindings] DB error:', error.message);
    return [];
  }
  return (data ?? []) as ScopeBinding[];
}

/** Translate a raw Supabase error from lorekit_scope_bind into a user-facing message. */
function translateBindError(message: string, code: string | undefined): string {
  if (message.startsWith('scope_bound_elsewhere:')) {
    return 'This scope is already bound to another organization.';
  }
  if (code === 'LK002' || message.startsWith('org_permission_denied:')) {
    return 'Only admins and owners can manage shared scopes.';
  }
  return message;
}

/**
 * Bind a scope to the org. Admin/owner only (`manage_scopes` capability via
 * lorekit_scope_bind). Returns the new binding id on success, or an error
 * string on failure.
 */
export async function bindScope(orgId: string, scope: string): Promise<{ id: string } | { error: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const trimmed = scope.trim().toLowerCase();
  if (!trimmed) return { error: 'Scope is required' };

  const { data: id, error } = await supabase.rpc('lorekit_scope_bind', {
    p_org_id: orgId,
    p_scope: trimmed,
  });
  if (error) return { error: translateBindError(error.message, error.code) };

  await recordAuditEvent({
    action: 'scope.bind',
    resourceType: 'org_scope_binding',
    resourceId: id as string,
    target: orgId,
    metadata: { scope: trimmed },
  });

  revalidatePath('/settings', 'layout');
  return { id: id as string };
}

/**
 * Unbind a scope from the org. Admin/owner only (`manage_scopes` capability
 * via lorekit_scope_unbind).
 */
export async function unbindScope(orgId: string, scope: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { error } = await supabase.rpc('lorekit_scope_unbind', {
    p_org_id: orgId,
    p_scope: scope,
  });
  if (error) return { error: translateBindError(error.message, error.code) };

  await recordAuditEvent({
    action: 'scope.unbind',
    resourceType: 'org_scope_binding',
    resourceId: orgId,
    target: orgId,
    metadata: { scope },
  });

  revalidatePath('/settings', 'layout');
  return {};
}
