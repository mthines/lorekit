/**
 * Lightweight scope utilities for the web package.
 * Duplicated from packages/mcp-core/src/scope.ts to avoid pulling
 * OTel, Supabase, and tool-handler code into the Next.js webpack bundle.
 * Keep in sync with the canonical implementation in mcp-core.
 */

export type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';

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
