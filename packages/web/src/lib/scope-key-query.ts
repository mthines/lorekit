/**
 * Splits a pasted `scope::key` identifier — the same string LoreKit prints
 * back at agents in a lesson write confirmation — into the `scope` and
 * `key_prefix` a `GET /memories` search can use.
 *
 * A memory's natural key is `scope::key`, and both halves are themselves
 * `::`-joined (a `repo::{owner}/{repo}` scope, an `aw-lessons::<slug>` key).
 * Concatenated, the two are indistinguishable from a single `::`-delimited
 * string without knowing where the scope grammar ends — this is that
 * boundary. `repo::mthines/lorekit::sandbox-lessons::lorekit-mcp-url-…`
 * parses to scope `repo::mthines/lorekit` (the grammar's fixed 2 segments)
 * and key prefix `sandbox-lessons::lorekit-mcp-url-…` (everything after).
 *
 * Pure and dependency-free so the boundary rule is unit-tested directly,
 * rather than asserted by exercising the command palette end to end.
 */

/** How many `::`-segments each scope prefix's grammar fixes, per `docs/scope-format.md`. */
const SCOPE_SEGMENT_COUNTS: Record<string, number> = {
  global: 1,
  project: 2,
  repo: 2,
  branch: 3,
};

export interface ScopeKeyQuery {
  /** The exact scope to filter by (`GET /memories?scope=`). */
  scope: string;
  /**
   * Case-insensitive prefix to match against `key`
   * (`GET /memories?key_prefix=`). Empty string means "any key in this scope".
   */
  keyPrefix: string;
}

/**
 * Parse `raw` as a `scope::key` (or `scope::key-prefix`) identifier.
 *
 * Returns `null` when `raw` does not open with a complete, recognized scope
 * prefix — either the first segment isn't one of `global`/`project`/`repo`/
 * `branch`, or the scope's own segments (e.g. `repo::{owner}/{repo}`) aren't
 * fully typed yet. `null` is the signal for the caller to fall back to a
 * plain substring search instead of a scope+key-prefix one.
 */
export function parseScopeKeyQuery(raw: string): ScopeKeyQuery | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('::');
  const prefix = (parts[0] ?? '').toLowerCase();
  const scopeSegments = SCOPE_SEGMENT_COUNTS[prefix];
  if (scopeSegments === undefined) return null;
  if (parts.length < scopeSegments) return null;

  return {
    scope: parts.slice(0, scopeSegments).join('::'),
    keyPrefix: parts.slice(scopeSegments).join('::'),
  };
}
