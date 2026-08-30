/**
 * The BOUNDED value behind the `lorekit.scope.type` telemetry attribute and
 * `usage_events.scope_type`.
 *
 * `scope.ts`'s `scopeType()` answers the same question for a scope that has
 * ALREADY passed `ScopeSchema`, so it can cast the prefix unchecked. The two
 * transport layers cannot: `mcp/mcp-handler.ts` reads `scope` straight out of
 * the tool arguments and `_shared/api/router.ts` reads it out of the query
 * string, both BEFORE any validation, and both used to do their own
 * `raw.split('::')[0]` on it. That splits an ungrammatical scope into whatever
 * the caller typed, so a dimension declared low-cardinality in
 * `otel-conventions.spec.ts` accepted arbitrary caller strings.
 *
 * Two rules follow, and they are the whole module:
 *
 * 1. A scope that is not grammatical reports `invalid` — one bucket, never the
 *    caller's own prefix. The request itself is unaffected: `validateScope`
 *    still rejects it on its own terms. This is a telemetry dimension, so it
 *    describes bad input rather than failing on it (the `safeValidateScope`
 *    posture).
 * 2. No scope at all reports `null`, and the caller OMITS the attribute rather
 *    than inventing one. An absent attribute is already how the transports
 *    treat `lorekit.scope` and `auth.user_id`; a placeholder is a value that
 *    aggregates, and `unknown` aggregated into the single largest bucket of the
 *    dimension while meaning "this tool takes no scope".
 *
 * The `scopes` fallback exists for exactly that reason. `memory.search` takes a
 * `scopes` ARRAY and no `scope`, so every search fell through to the
 * placeholder and the dimension said nothing about what searches actually
 * query. A search over one type reports that type; over several, `mixed` —
 * matching the `'mixed'` its own metric already records in
 * `tools/search.ts`.
 *
 * Import-free, so it can be mirrored verbatim into
 * `supabase/functions/_shared/scope/scope-type-attribute.ts` and kept in sync by
 * `edge-parity.spec.ts` — the `rest-tool-name.ts` pattern.
 */

/**
 * The closed vocabulary. `global`/`project`/`repo`/`branch` mirror
 * `scope.ts`'s `ScopePrefix`; `mixed` and `invalid` are the two answers a
 * single prefix cannot give.
 */
export type ScopeTypeAttribute = 'global' | 'project' | 'repo' | 'branch' | 'mixed' | 'invalid';

const VALID_PREFIXES = new Set<string>(['global', 'project', 'repo', 'branch']);

/**
 * The type of ONE scope string.
 *
 * Deliberately looser than `validateScope`: it only has to place the scope in a
 * bucket, so it checks the prefix and stops. A grammatical prefix with a
 * malformed tail (`repo::not-a-path`) still reports `repo` — the tail is
 * `validateScope`'s business, and reporting `invalid` here would make the
 * dimension disagree with the error the caller actually received.
 */
function typeOfScope(scope: string): ScopeTypeAttribute {
  const normalized = scope.toLowerCase().trim();
  if (normalized === 'global') return 'global';

  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) return 'invalid';

  const prefix = normalized.slice(0, sepIdx);
  return VALID_PREFIXES.has(prefix) ? (prefix as ScopeTypeAttribute) : 'invalid';
}

/**
 * Resolve the attribute for a request, from whichever of the two scope-shaped
 * arguments it carries.
 *
 * Total by construction — every input maps to a member of the vocabulary or to
 * `null`, and a `null` means "omit the attribute", never "record a placeholder".
 * `scope` wins over `scopes` when both are present: no tool takes both today,
 * and the singular form is the one the request is keyed on.
 */
export function scopeTypeAttribute(scope: unknown, scopes?: unknown): ScopeTypeAttribute | null {
  if (typeof scope === 'string' && scope.trim().length > 0) return typeOfScope(scope);

  if (Array.isArray(scopes)) {
    const types = new Set<ScopeTypeAttribute>();
    for (const entry of scopes) {
      if (typeof entry === 'string' && entry.trim().length > 0) types.add(typeOfScope(entry));
    }
    if (types.size === 0) return null;
    if (types.size === 1) return [...types][0] as ScopeTypeAttribute;
    return 'mixed';
  }

  return null;
}
