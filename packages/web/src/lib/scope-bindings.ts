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
 * The bind form's scope catalog is NOT read here: it comes from
 * `GET /memories/scopes` through the shared scope-tree query (see
 * `BindScopeForm`). A `memories` select deduped in JS, which is how this file
 * used to build it, only ever sees a prefix of the rows.
 *
 * Error translation:
 *  - SQLSTATE P0001, message starting with `scope_bound_elsewhere:` → friendly
 *    "This scope is already bound to another organization."
 *  - SQLSTATE LK002 (org_permission_denied) → "Only admins and owners can
 *    manage shared scopes."
 *  - SQLSTATE P0001, message starting with `invalid_scope_pattern:` → friendly
 *    scope-pattern hint (migration 00111's SQL-side grammar gate — a
 *    defense-in-depth backstop behind `validateScopeBindingPattern` below, so
 *    a malformed pattern that somehow reaches the RPC directly still gets a
 *    readable message instead of a raw constraint string).
 */

import { createServerClient } from '@/lib/supabase/server';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';
import { validateScopeBindingPattern } from '@/lib/scope-bindings-validate';

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
  const user = await getVerifiedUser();
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

/**
 * List scope bindings across several orgs in ONE RLS-scoped read, instead of
 * one `listScopeBindings` call (client + `auth.getUser()`) per org. RLS
 * (`rls_scope_bindings_select`) already restricts rows to orgs the caller is a
 * member of, so a non-member org id in `orgIds` simply returns nothing.
 */
export async function listScopeBindingsForOrgs(orgIds: string[]): Promise<ScopeBinding[]> {
  if (orgIds.length === 0) return [];
  const supabase = await createServerClient();
  const user = await getVerifiedUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('org_scope_bindings')
    .select('id, org_id, scope, created_by, created_at')
    .in('org_id', orgIds)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[listScopeBindingsForOrgs] DB error:', error.message);
    return [];
  }
  return (data ?? []) as ScopeBinding[];
}

/** Translate a raw Supabase error from a scope-binding RPC into a user-facing message. */
function translateScopeError(message: string, code: string | undefined): string {
  if (message.startsWith('scope_bound_elsewhere:')) {
    return 'This scope is already bound to another organization.';
  }
  if (code === 'LK002' || message.startsWith('org_permission_denied:')) {
    return 'Only admins and owners can manage shared scopes.';
  }
  if (message.startsWith('invalid_scope_pattern:')) {
    return 'Invalid scope pattern. Use a canonical scope (repo::owner/name) or an owner wildcard ending in "/*" or "::*".';
  }
  return message;
}

/**
 * Bind a scope (exact or owner wildcard, e.g. `repo::owner/*`) to the org.
 * Admin/owner only (`manage_scopes` capability via lorekit_scope_bind).
 */
export async function bindScope(orgId: string, scope: string): Promise<{ id: string } | { error: string }> {
  const supabase = await createServerClient();
  const user = await getVerifiedUser();
  if (!user) return { error: 'Not authenticated' };

  const validated = validateScopeBindingPattern(scope);
  if (!validated.ok) return { error: validated.error };
  const trimmed = validated.normalized;

  const { data: id, error } = await supabase.rpc('lorekit_scope_bind', {
    p_org_id: orgId,
    p_scope: trimmed,
  });
  if (error) return { error: translateScopeError(error.message, error.code) };

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
  const user = await getVerifiedUser();
  if (!user) return { error: 'Not authenticated' };

  // Normalise identically to bindScope — a scope is stored lowercased, so an
  // un-lowercased unbind would silently match nothing.
  const normalized = scope.trim().toLowerCase();
  const { error } = await supabase.rpc('lorekit_scope_unbind', {
    p_org_id: orgId,
    p_scope: normalized,
  });
  if (error) return { error: translateScopeError(error.message, error.code) };

  await recordAuditEvent({
    action: 'scope.unbind',
    resourceType: 'org_scope_binding',
    resourceId: normalized,
    target: orgId,
    metadata: { scope: normalized },
  });

  revalidatePath('/settings', 'layout');
  return {};
}
