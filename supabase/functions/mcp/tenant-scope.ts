/**
 * The single widened tenant-visibility predicate for a memories query.
 *
 * Self-contained mirror of the shared Node module
 * (packages/mcp-core/src/tenant-scope.ts) — the Deno edge function cannot
 * cross-import the Node package (Deno / Node.js MCP SDK incompatibility), so
 * this copy is duplicated verbatim, the same pattern as created-at.ts /
 * webhook-secret-select.ts. Keep the two in sync; drift is caught by
 * edge-parity.spec.ts on the mcp-core side.
 *
 * Mirrors the sole SQL source of truth, lorekit_member_org_ids() (see
 * supabase/migrations/00014_orgs.sql): a caller sees their own rows OR any
 * row owned by an org they belong to. This module only shapes the
 * PostgREST filter from an already-resolved org-id list — it never
 * re-derives membership itself, so the predicate can never drift from the
 * SQL side (Requirement R2: exactly one enforced place).
 */

/**
 * Apply the tenant-visibility filter to a memories query.
 *
 * Total function: an empty `orgIds` returns a personal-only filter and NEVER
 * emits an `org_id.in.()` fragment — an empty PostgREST `in.()` list is a
 * match-all/error footgun, not "caller is in no org" (Requirement R3).
 */
export function applyTenantScope<Q extends {
  eq(col: string, val: string): Q;
  or(filter: string): Q;
}>(query: Q, userId: string, orgIds: string[]): Q {
  if (orgIds.length === 0) {
    return query.eq('user_id', userId);
  }
  const quoted = orgIds.map((id) => `"${id}"`).join(',');
  return query.or(`user_id.eq.${userId},org_id.in.(${quoted})`);
}

/**
 * Narrow a caller's real org memberships by a credential's org allow-list.
 *
 * An OAuth-issued token carries the org selection the user made on the consent
 * screen (api_tokens.org_ids, 00049_oauth.sql). That selection may only ever
 * SUBTRACT: `memberOrgIds` stays the authority on what the human can reach, so
 * leaving an org revokes access immediately even though the token still names
 * it, and a token can never be edited into access its holder does not have.
 *
 * `null` means "no restriction" — the pre-OAuth behaviour every personal
 * dashboard token keeps, with no backfill. An empty array is meaningful and
 * distinct: the user deliberately granted personal lore only.
 */
export function intersectTokenOrgIds(
  tokenOrgIds: string[] | null | undefined,
  memberOrgIds: string[],
): string[] {
  if (tokenOrgIds == null) return memberOrgIds;
  const allowed = new Set(tokenOrgIds);
  return memberOrgIds.filter((id) => allowed.has(id));
}

/**
 * Is a single org id inside a credential's allow-list?
 *
 * The point-lookup counterpart to intersectTokenOrgIds, for the write and
 * delete paths where the caller names ONE org by slug rather than reading
 * across all of them. It lives here, beside the set version, so every place a
 * token's org allow-list is consulted goes through this one module — the same
 * reasoning that keeps the tenant predicate singular.
 *
 * NARROWING ONLY. A `true` here means "the credential does not forbid it", not
 * "the caller may do it": role authorization still happens inside
 * lorekit_org_can (memory_write / memory_delete), which this can never
 * override.
 */
export function tokenAllowsOrgId(
  tokenOrgIds: string[] | null | undefined,
  orgId: string,
): boolean {
  if (tokenOrgIds == null) return true;
  return tokenOrgIds.includes(orgId);
}
