/**
 * Tenant-scoping helpers for REST handlers.
 *
 * REST api_key auth uses the service-role Supabase client (bypasses RLS).
 * Every read query must apply applyRestTenantScope so users only see their
 * own memories plus org-shared memories. JWT auth uses an RLS-scoped client,
 * so no filtering is needed — RLS handles it automatically.
 *
 * This module mirrors the logic in supabase/functions/mcp/tenant-scope.ts and
 * packages/mcp-core/src/tenant-scope.ts but is specific to the REST shared
 * API (different import chain, different span naming).
 */
import { createTracedClient } from '../otel.ts';
import type { Span, TracedQuery } from '../otel.ts';
import type { AuthContext, DbClient } from './auth.ts';

/**
 * Resolve the org IDs the user is a member of via the single-source RPC.
 * Fails closed — any RPC error returns an empty array (personal-only filter).
 * A `lorekit.rest.auth.org_ids` child span is created for observability.
 */
export async function getMemberOrgIds(db: DbClient, userId: string, parentSpan: Span): Promise<string[]> {
  const span = parentSpan.child('lorekit.rest.auth.org_ids');
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<string>('lorekit_member_org_ids', { p_user_id: userId });
  if (error) {
    span.setAttributes({ 'auth.org_ids_error': error.message }).end();
    return [];
  }
  const ids = (data ?? []) as string[];
  span.setAttributes({ 'lorekit.org_count': ids.length }).end();
  return ids;
}

/**
 * Apply tenant scoping to a query for api_key callers (service-role client).
 * JWT callers use RLS — do not apply this filter for them.
 *
 * Returns the query unchanged when auth.type === 'service' (CI — full access).
 */
export function applyRestTenantScope<Q extends TracedQuery<unknown>>(
  q: Q,
  userId: string,
  orgIds: string[],
): Q {
  if (orgIds.length === 0) {
    return q.eq('user_id', userId) as Q;
  }
  const joined = orgIds.join(',');
  return q.or(`user_id.eq.${userId},org_id.in.(${joined})`) as Q;
}

/**
 * True when the caller's queries are NOT already narrowed by RLS and therefore
 * need an explicit tenant predicate applied in application code.
 *
 * Only `api_key` qualifies. `user` (JWT) runs on an RLS-scoped client, and
 * `service` is the CI/full-access tier that deliberately keeps unrestricted
 * reads — exactly as in `memories`. Never special-case `service` into a filter
 * here; that would break the CI smoke path and is not what protects tenants.
 */
export function needsExplicitTenantFilter(auth: AuthContext): boolean {
  return auth.type === 'api_key' && typeof auth.userId === 'string';
}

/**
 * Restrict an `org_members` query to the caller's OWN membership rows.
 *
 * `GET /orgs` is a bare `from('org_members')` select with no filter — correct
 * for the JWT client, where `rls_org_members_select` narrows it, and a total
 * tenant leak on the service-role client the api_key tier uses (it would return
 * every membership row in the database). A no-op for JWT/service callers.
 */
export function applyOwnMembershipFilter<Q extends TracedQuery<unknown>>(q: Q, auth: AuthContext): Q {
  if (!needsExplicitTenantFilter(auth)) return q;
  return q.eq('user_id', auth.userId as string) as Q;
}

/**
 * Membership gate for a single org, for handlers that resolve an org by slug
 * with a raw `from('orgs')` select.
 *
 * That select relies entirely on `rls_orgs_select` to hide orgs the caller does
 * not belong to. Under the service-role client used by the api_key tier there
 * is no RLS, so ANY org becomes readable by guessing its slug. This restores
 * the membership requirement explicitly.
 *
 * Membership truth comes from `lorekit_member_org_ids` via `getMemberOrgIds` —
 * the single tenant-visibility predicate (00014/00025, which also excludes
 * soft-deleted orgs) — never a hand-rolled `org_members` query.
 *
 * Callers MUST answer a false result with the same `notFound('Organization')`
 * they return for a slug that does not exist. Any response that lets a caller
 * distinguish an org they are not in (403, a different body) from an org that
 * is not there turns this endpoint into an org-existence oracle over the whole
 * slug namespace.
 */
export async function isOrgMember(
  db: DbClient,
  auth: AuthContext,
  orgId: string,
  span: Span,
): Promise<boolean> {
  if (!needsExplicitTenantFilter(auth)) return true;
  const orgIds = await getMemberOrgIds(db, auth.userId as string, span);
  return orgIds.includes(orgId);
}

/**
 * Capability gate for a raw (non-RPC) read whose JWT equivalent is enforced by
 * a `lorekit_org_can`-based RLS policy.
 *
 * `org_invites` is the case that needs it: `rls_org_invites_select_manage`
 * shows an org's invites only to a caller with the `invite` capability
 * (admin/owner), so a plain member's JWT read comes back empty. A raw
 * service-role select would instead return every invite — including invitee
 * email addresses — to any member holding a token. This asks the SAME function
 * the policy asks; the role -> capability matrix is never re-derived here.
 *
 * Returns true for JWT/service callers, whose reads are already governed by the
 * policy itself (or intentionally unrestricted, for CI).
 */
export async function hasOrgCapability(
  db: DbClient,
  auth: AuthContext,
  orgId: string,
  capability: string,
  parentSpan: Span,
): Promise<boolean> {
  if (!needsExplicitTenantFilter(auth)) return true;
  const span = parentSpan.child('lorekit.rest.auth.org_can');
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_can', {
    p_user_id: auth.userId as string,
    p_org_id: orgId,
    p_capability: capability,
  });
  if (error) {
    // Fail closed: an unresolvable capability is a denial, never a grant.
    span.setAttributes({ 'auth.org_can_error': error.message }).end();
    return false;
  }
  // A scalar-returning RPC yields the bare boolean, not a row set. Compared with
  // `=== true` so anything unexpected (null, a string, a wrapped row) denies
  // rather than being coerced into a grant.
  const granted = (data as unknown) === true;
  span.setAttributes({ 'lorekit.org.capability': capability, 'lorekit.org.capability_granted': granted }).end();
  return granted;
}
