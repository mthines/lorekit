/**
 * Lightweight scope utilities for the web package.
 * Duplicated from packages/mcp-core/src/scope.ts to avoid pulling
 * OTel, Supabase, and tool-handler code into the Next.js webpack bundle.
 * Keep in sync with the canonical implementation in mcp-core.
 */

export type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';

const VALID_PREFIXES: readonly string[] = ['global', 'project', 'repo', 'branch'];

/**
 * The canonical charset a scope may use, mirroring the edge validator's
 * `/^[\w.:/-]+$/` guard (`supabase/functions/_shared/scope.ts`). A canonical
 * scope only ever uses word chars plus `. : / -`; the edge rejects anything
 * else because a scope is interpolated into a PostgREST `.or()` filter where
 * `"` `,` `(` `)` are structural.
 */
const CANONICAL_CHARSET = /^[\w.:/-]+$/;

/**
 * Is `raw` a scope the API will ACCEPT as a filter?
 *
 * This mirrors `parseScopeFilter` in `supabase/functions/_shared/scope.ts` —
 * the entry point five of the six scope-filtering routes now call — and
 * deliberately NOT the stricter per-prefix grammar in
 * `packages/mcp-core/src/scope.ts`. Mirroring the stricter one would have the
 * dashboard refuse a scope the server happily serves (`global::something` is
 * the live example), which is a worse failure than the one this guards against:
 * it would hide real data behind a filter the user can see in the chip strip.
 *
 * `scope-parity.spec.ts` executes that agreement against the edge module rather
 * than asserting it in prose, so the two cannot drift into a 400 again.
 *
 * The asymmetry this originally existed to absorb is GONE as of the
 * scope-filter-validation change: `GET /memories`, `/activity`, `/facets`,
 * `/read-activity`, `DELETE /memories` and `POST /memories/restore` now ALL
 * validate `?scope=` and answer 400 on an ungrammatical value (the deliberate
 * "a filter is the question itself" rule — see
 * `supabase/functions/memories/CLAUDE.md`). They share the GRAMMAR only:
 * `/read-activity` reaches it through the normalising `validateScope`, the
 * other five through `parseScopeFilter`, so the six agree on what is legal and
 * differ on what is done with a legal value. An ungrammatical scope therefore
 * fails the page uniformly rather than breaking one card next to four that look
 * merely empty. This guard matters MORE after that change, not less: it is what
 * keeps the client from ever sending one, so the uniform failure stays
 * theoretical.
 *
 * MIXED CASE IS CANONICAL HERE, and that inverted with the reject-only change.
 * This guard used to refuse anything not already lowercased, on the ground that
 * the edge normalised and so only the normalised form described what the server
 * would filter on. `parseScopeFilter` does not normalise — it returns the
 * caller's own string, which is what reaches `.eq('scope', …)` — so the raw
 * value IS what the server filters on, and refusing it was the one thing
 * stopping the Explorer from reaching the mixed-case rows the REST write path
 * stores verbatim. Refusing it hid real data behind a filter the UI offers,
 * which is the quieter and worse of the two failure directions.
 *
 * PADDING IS NOT canonical, and that also follows the edge: `parseScopeFilter`
 * rejects surrounding whitespace outright, because the grammar check trims it
 * away while the predicate does not.
 *
 * One card reads differently, by design: `GET /memories/read-activity` filters
 * `usage_events.scope`, which is lowercased when the event is recorded, so it
 * normalises the filter. A mixed-case scope therefore charts reads for its
 * lowercased form while the list shows the exact rows. Each side matches how
 * its own column is written; see `supabase/functions/memories/CLAUDE.md`.
 */
export function isCanonicalScope(raw: string): boolean {
  if (!raw) return false;
  // Padding is rejected by the edge filter, so it is not canonical here either.
  if (raw !== raw.trim()) return false;
  if (/^(project|repo|branch):[^:]/i.test(raw)) return false;
  // Case is carried through to the predicate, so the GRAMMAR is checked against
  // the lowercased form (as the edge does) while the VALUE stays the caller's.
  const lower = raw.toLowerCase();
  if (lower === 'global') return true;
  const sepIdx = lower.indexOf('::');
  if (sepIdx === -1) return false;
  if (!VALID_PREFIXES.includes(lower.slice(0, sepIdx))) return false;
  return CANONICAL_CHARSET.test(raw);
}

/**
 * What the Explorer should do with a `?scope=` it just read off the URL.
 *
 * `scope` is the value to filter by (`null` = all scopes) and `rejected` is the
 * value that was thrown away, so the page can SAY it ignored the filter instead
 * of silently answering a wider question than the link asked for. Exactly one
 * of the two is ever non-null.
 *
 * Pure and exported because this is the seam the bug lived at: a `?scope=` is
 * fanned out to five endpoints on every render, and it is only worth reasoning
 * about once, here.
 */
export interface ResolvedScopeParam {
  scope: string | null;
  rejected: string | null;
}

export function resolveScopeParam(raw: string | null): ResolvedScopeParam {
  if (raw === null || raw === '') return { scope: null, rejected: null };
  return isCanonicalScope(raw)
    ? { scope: raw, rejected: null }
    : { scope: null, rejected: raw };
}

/**
 * Return the scope type for use as a low-cardinality attribute/badge label.
 */
export function scopeType(scope: string): ScopePrefix {
  if (scope === 'global') return 'global';
  const prefix = scope.split('::')[0] as ScopePrefix;
  return prefix;
}

/**
 * Derive the GitHub URL for a scope that names a repository.
 *
 * The repo is already encoded in the scope string, so no link needs to be
 * stored — it's a pure function of the scope:
 *   `repo::owner/repo`            → https://github.com/owner/repo
 *   `branch::owner/repo::branch`  → https://github.com/owner/repo/tree/branch
 *
 * Returns `null` for `global` / `project` scopes (no repository to point at)
 * and for malformed scopes.
 *
 * Note on case: canonical scopes are lowercased upstream. GitHub matches
 * owner/repo case-insensitively (and redirects), so repo links are always
 * safe. Branch names are case-sensitive in git, so a `/tree/<branch>` link
 * for a branch that was authored with upper-case characters may 404 — an
 * accepted trade-off for pointing directly at the branch.
 */
/**
 * What a scope string already tells the reader about a repository.
 *
 * This is the counterpart to `lib/origin.ts` and exists so the two never
 * contradict or duplicate each other: `scopeRepoRef` says what the scope
 * ALREADY conveys (and therefore what the "Repo" metadata row already links),
 * and `originLinks` renders only the provenance the scope cannot express.
 *
 * `repo` and `branch` are `null` for `global` / `project` / malformed scopes.
 */
export interface ScopeRepoRef {
  /** `owner/name`, lowercased by the canonical scope format. */
  repo: string | null;
  /** The branch a `branch::` scope names; `null` for every other scope type. */
  branch: string | null;
}

export function scopeRepoRef(scope: string): ScopeRepoRef {
  const type = scopeType(scope);

  if (type === 'repo') {
    const ownerRepo = scope.slice('repo::'.length);
    return REPO_RE.test(ownerRepo) ? { repo: ownerRepo, branch: null } : { repo: null, branch: null };
  }

  if (type === 'branch') {
    const [, ownerRepo, branch] = scope.split('::');
    if (!ownerRepo || !branch || !REPO_RE.test(ownerRepo)) return { repo: null, branch: null };
    return { repo: ownerRepo, branch };
  }

  return { repo: null, branch: null };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * True when any `/`-separated segment of `value` is made only of dots.
 *
 * `.` and `..` both satisfy `[\w.-]+`, so `repo::../evil` is a well-formed
 * scope as far as `REPO_RE` is concerned — and the browser resolves
 * `https://github.com/../evil` to `https://github.com/evil`, a link to a
 * repository the scope does not name. `lib/origin.ts` applies the same rule to
 * the stored provenance; a scope is no more trustworthy, since a write can
 * name any scope string.
 */
function hasRelativeSegment(value: string): boolean {
  return value.split('/').some((segment) => /^\.+$/.test(segment));
}

export function scopeRepoUrl(scope: string): string | null {
  const { repo, branch } = scopeRepoRef(scope);
  if (!repo || hasRelativeSegment(repo)) return null;
  if (branch && hasRelativeSegment(branch)) return null;
  return branch ? `https://github.com/${repo}/tree/${branch}` : `https://github.com/${repo}`;
}
