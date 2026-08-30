/**
 * Tenant-scoping helpers for REST handlers.
 *
 * REST api_key auth uses the service-role Supabase client (bypasses RLS).
 * Every read query must apply applyRestTenantScope so users only see their
 * own memories plus org-shared memories. JWT auth uses an RLS-scoped client,
 * so no filtering is needed — RLS handles it automatically.
 *
 * The narrowing arithmetic itself is IMPORTED from the single mirrored
 * supabase/functions/_shared/auth/tenant-scope.ts (shared with the MCP surface); what
 * lives here is the REST-specific plumbing around it — the org-id RPC with its
 * span, and the auth-tier predicates. It used to duplicate
 * packages/mcp-core/src/auth/tenant-scope.ts but is specific to the REST shared
 * API (different import chain, different span naming).
 */
import { createTracedClient } from '../telemetry/otel.ts';
import type { Span, TracedQuery } from '../telemetry/otel.ts';
import type { AuthContext, DbClient } from './auth.ts';
import { keyRestriction } from './auth.ts';
import { scopeAllowedByKey } from '../schemas/api-key.ts';
import {
  effectiveOrgIds,
  keyScopeFilter,
  ownRowsFragment,
  restrictsTenancy,
  type KeyRestriction,
} from '../auth/tenant-scope.ts';

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
 *
 * The optional `key` is the calling API key's restriction (00068), and it is
 * applied HERE for the same reason the MCP side applies it inside
 * `applyTenantScope`: a scoped key must not see an out-of-allowlist row on a
 * read that names no scope at all (`GET /memories` unfiltered, `/search` across
 * scopes), and a per-handler check cannot cover that. The narrowing arithmetic
 * itself is not re-implemented — it is imported from the single mirrored
 * `tenant-scope.ts`, so the two surfaces cannot disagree about what a key
 * reaches.
 */
export function applyRestTenantScope<Q extends TracedQuery<unknown>>(
  q: Q,
  userId: string,
  orgIds: string[],
  key?: KeyRestriction,
): Q {
  const visibleOrgIds = effectiveOrgIds(orgIds, key);
  // Each id QUOTED, matching the MCP-side `applyTenantScope` exactly. An
  // unquoted PostgREST `in.()` list breaks on any member containing a comma or
  // a parenthesis; a uuid never does, but the two surfaces answering the same
  // question with two different fragments is the drift this module is supposed
  // to have removed.
  // The ownership disjunct is `ownRowsFragment`, not a hand-rolled
  // `user_id.eq.…`: under a tenancy-restricted key it also has to exclude the
  // owner's OWN org-owned rows, and a second copy of that rule here is exactly
  // the drift this module says it removed.
  let out = visibleOrgIds.length === 0
    ? (q.eq('user_id', userId) as Q)
    : (q.or(`${ownRowsFragment(userId, key)},org_id.in.(${visibleOrgIds.map((id) => `"${id}"`).join(',')})`) as Q);
  if (visibleOrgIds.length === 0 && restrictsTenancy(key)) out = out.or('org_id.is.null') as Q;
  const scopeFilter = keyScopeFilter(key);
  // A second `.or()` — PostgREST ANDs top-level filters, so this reads as
  // "(mine or my orgs') AND (in the key's allowlist)".
  if (scopeFilter) out = out.or(scopeFilter) as Q;
  return out;
}

/**
 * Narrow a query to the calling key's scope allowlist, and nothing else.
 *
 * The write family (`PATCH`, `DELETE`, `POST /restore`) is personal-only — it
 * never widens to org rows — so it does not call `applyRestTenantScope` and was
 * therefore missing the allowlist half of the boundary entirely: a scoped key
 * could PATCH or DELETE a memory outside its allowlist BY ID, because `user_id`
 * alone was the whole filter. This adds the missing half without pulling those
 * handlers into a tenancy widening they deliberately do not want.
 *
 * A no-op for a JWT/service caller and for an unrestricted key.
 */
export function applyKeyScopeFilter<Q extends TracedQuery<unknown>>(q: Q, auth: AuthContext): Q {
  const filter = keyScopeFilter(keyRestriction(auth));
  return filter ? (q.or(filter) as Q) : q;
}

/**
 * The first scope in `named` the calling key may not reach, or `null`.
 *
 * The REST twin of the MCP dispatcher's early refusal, and it exists for the
 * same reason: when a request NAMES a scope, a plain 403 is a better answer
 * than an empty result set, which reads as "there is nothing there" and sends
 * the caller looking for a bug in their data. Reads that name no scope are
 * narrowed by `applyRestTenantScope` instead, because there is nothing to
 * refuse.
 *
 * Every named scope must be allowed, not just one: refusing the whole call is
 * honest, where quietly answering over the allowed subset would answer a
 * different question than the one asked.
 *
 * Returns `null` for a JWT or service caller — they have no key — and for an
 * unrestricted key, so an unscoped token is byte-for-byte unaffected.
 */
export function firstDeniedScope(auth: AuthContext, named: readonly (string | null | undefined)[]): string | null {
  const key = keyRestriction(auth);
  if (!key || key.scopes.length === 0) return null;
  for (const raw of named) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (!scopeAllowedByKey(key.scopes, raw.toLowerCase().trim())) return raw;
  }
  return null;
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
