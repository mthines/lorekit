/**
 * The single widened tenant-visibility predicate for a memories query.
 *
 * Mirrors the sole SQL source of truth, lorekit_member_org_ids() (see
 * supabase/migrations/00013_orgs.sql): a caller sees their own rows OR any
 * row owned by an org they belong to. This module only shapes the
 * PostgREST filter from an already-resolved org-id list — it never
 * re-derives membership itself, so the predicate can never drift from the
 * SQL side (Requirement R2: exactly one enforced place).
 *
 * Mirrored (self-contained, no cross-package import) in
 * supabase/functions/mcp/tenant-scope.ts for the Deno edge function — the
 * same pattern used for created-at.ts / webhook-secret-select.ts. Keep the
 * two in sync when either changes (guarded by edge-parity.spec.ts).
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
