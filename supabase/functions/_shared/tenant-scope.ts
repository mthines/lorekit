/**
 * The single widened tenant-visibility predicate for a memories query.
 *
 * Mirrors the sole SQL source of truth, lorekit_member_org_ids() (see
 * supabase/migrations/00014_orgs.sql): a caller sees their own rows OR any
 * row owned by an org they belong to. This module only shapes the
 * PostgREST filter from an already-resolved org-id list — it never
 * re-derives membership itself, so the predicate can never drift from the
 * SQL side (Requirement R2: exactly one enforced place).
 *
 * THIS FILE is the edge mirror: a self-contained copy of
 * packages/mcp-core/src/tenant-scope.ts, which the Deno edge functions cannot
 * cross-import. It lives in _shared/ rather than mcp/ because BOTH the MCP and
 * REST surfaces import it — the same pattern used for created-at.ts /
 * webhook-secret-select.ts. Keep the two in sync when either changes;
 * edge-parity.spec.ts fails when they drift (it strips comments, so this header
 * is free to describe the mirror rather than repeat the source's).
 */

/**
 * The calling API key's own restriction (migration 00067), as the transports
 * read it off `api_tokens`.
 *
 * Declared here rather than imported so this module stays import-free and can
 * be mirrored verbatim into the edge function. A JWT or service-role caller has
 * no key and passes `undefined` — which is why every parameter below is
 * optional and the unrestricted case is byte-for-byte the pre-00067 behaviour.
 */
export interface KeyRestriction {
  /** Allowlist of scope patterns. EMPTY = unrestricted. */
  scopes: string[];
  orgAccess: 'all' | 'personal' | 'selected';
  /** Meaningful only under `selected`. */
  orgIds: string[];
}

/**
 * Build a `KeyRestriction` from the raw `api_tokens` row the transports select.
 *
 * Total, and fail-closed on the one value that matters: an `org_access` the
 * code does not recognise becomes `personal`, the NARROWEST tenancy, not `all`.
 * A row can only carry an unknown value if `api_tokens_org_access_valid` was
 * dropped or a BYOD install predates it, and in that state "I do not understand
 * this restriction" must not resolve to "there is no restriction".
 *
 * The scope list degrades the other way — a non-array becomes empty, i.e.
 * unrestricted — because that is the DEFAULT for every key ever created, so
 * treating an unreadable value as "deny everything" would brick unscoped keys
 * on any read hiccup. The asymmetry is deliberate: `org_access` has no safe
 * default to fall back to, `scopes` does.
 */
export function normalizeKeyRestriction(row: {
  scopes?: unknown;
  org_access?: unknown;
  org_ids?: unknown;
}): KeyRestriction {
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((s): s is string => typeof s === 'string')
    : [];
  const orgIds = Array.isArray(row.org_ids)
    ? row.org_ids.filter((s): s is string => typeof s === 'string')
    : [];
  const raw = row.org_access;
  const orgAccess: KeyRestriction['orgAccess'] =
    raw === 'all' || raw === 'personal' || raw === 'selected'
      ? raw
      // Absent is the pre-00067 shape (the column did not exist), which IS
      // unrestricted. Present-but-unrecognised is corruption, and denies.
      : raw == null
        ? 'all'
        : 'personal';
  return { scopes, orgAccess, orgIds };
}

/**
 * Narrow the caller's member-org list by the calling key's tenancy.
 *
 * An INTERSECTION, never a substitution: a key can only take away orgs its
 * owner already had. Handing back `key.orgIds` directly would let a stale row —
 * an org the owner was removed from after the key was scoped — keep granting
 * access, which is precisely the drift the single `lorekit_member_org_ids`
 * predicate exists to prevent.
 */
export function effectiveOrgIds(memberOrgIds: string[], key?: KeyRestriction): string[] {
  if (!key || key.orgAccess === 'all') return memberOrgIds;
  if (key.orgAccess === 'personal') return [];
  return memberOrgIds.filter((id) => key.orgIds.includes(id));
}

/**
 * The PostgREST `or()` fragment for a key's scope allowlist, or `null` when the
 * key is unrestricted and no fragment should be added at all.
 *
 * `null` rather than a match-everything fragment: successive `.or()` calls are
 * ANDed by PostgREST, so an always-true fragment is dead weight on every query
 * an unscoped key makes — which is nearly all of them.
 *
 * A trailing `*` becomes a `like` prefix match, with `_` escaped so
 * `repo::my_org/*` stays owner-exact rather than also matching `repo::myXorg/…`
 * — the same escape `expandScopeForSearch` applies, for the same reason.
 *
 * The shape test is `SCOPE_PATTERN` from `schemas/api-key.ts` — the authority
 * that guards the column at write time — and not a looser approximation of it.
 * A `*` is a wildcard only directly after `/` or `::`, so `repo::mthines/lore*`
 * is a MALFORMED pattern and is dropped rather than admitted as a `lore%` prefix
 * that reaches every repo starting with those letters. Admitting it would widen
 * the key, which is the one direction this filter must never move, and the
 * stored-bad-pattern case is precisely what it exists for.
 *
 * SECURITY: the fragment is interpolated into a filter string where `,` `(` `)`
 * are grammar, so a pattern outside the canonical charset would inject extra OR
 * predicates into the filter tree. `api_tokens_scopes_shape` already rejects
 * those at write time; this DROPS any that somehow got stored anyway, rather
 * than trusting the column. Dropping is the fail-closed direction — a discarded
 * pattern can only ever narrow what the key reaches.
 */
export function keyScopeFilter(key?: KeyRestriction): string | null {
  if (!key || key.scopes.length === 0) return null;
  const safe = key.scopes.filter((p) => /^[a-z0-9._:/-]+(?:(?:\/|::)\*)?$/.test(p));
  if (safe.length === 0) {
    // Every pattern was malformed. The key IS restricted, so matching nothing
    // is the only honest answer — an impossible predicate rather than none.
    return 'scope.is.null';
  }
  return safe
    .map((p) =>
      p.endsWith('*')
        ? `scope.like.${p.slice(0, -1).replace(/_/g, '\\_')}%`
        : `scope.eq.${p}`,
    )
    .join(',');
}

/**
 * Apply the tenant-visibility filter to a memories query.
 *
 * Total function: an empty `orgIds` returns a personal-only filter and NEVER
 * emits an `org_id.in.()` fragment — an empty PostgREST `in.()` list is a
 * match-all/error footgun, not "caller is in no org" (Requirement R3).
 *
 * The optional `key` is the calling API key's restriction (00067). It is
 * applied HERE, in the one place every read already funnels through, rather
 * than at each call site: a scoped key must not see an out-of-allowlist row
 * even on a read that names no scope at all (`memory.list` unfiltered,
 * `memory.search` across scopes), and a per-call-site check cannot cover that.
 * Requirement R2 — exactly one enforced place — now covers both axes.
 */
export function applyTenantScope<Q extends {
  eq(col: string, val: string): Q;
  or(filter: string): Q;
}>(query: Q, userId: string, orgIds: string[], key?: KeyRestriction): Q {
  const visibleOrgIds = effectiveOrgIds(orgIds, key);
  let q = visibleOrgIds.length === 0
    ? query.eq('user_id', userId)
    : query.or(`user_id.eq.${userId},org_id.in.(${visibleOrgIds.map((id) => `"${id}"`).join(',')})`);
  const scopeFilter = keyScopeFilter(key);
  // A second `.or()` — PostgREST ANDs top-level filters, so this reads as
  // "(mine or my orgs') AND (in the key's allowlist)".
  if (scopeFilter) q = q.or(scopeFilter);
  return q;
}
