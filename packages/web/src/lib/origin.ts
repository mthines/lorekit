/**
 * Memory origin (provenance) — "recorded from" link derivation.
 *
 * A memory's `scope` says WHERE the lesson applies; `lib/scope.ts`'s
 * `scopeRepoUrl` derives a repo link from it. The origin columns (migration
 * 00046) say where the lesson was RECORDED FROM — the repo, branch, commit,
 * and pull request the agent was actually working in when it wrote the lesson.
 * A `global` lesson learned while reviewing PR #482 has no repo in its scope
 * at all, so this cannot be derived from the scope and has to be stored.
 *
 * Pure and dependency-free (the functional core), so it is unit-testable in
 * the node vitest project and safe to import from a server component.
 *
 * Every function is total: a partially-populated or malformed origin yields
 * fewer links, never a throw and never a broken href.
 */

/** The origin columns as they arrive on a memory row. */
export interface MemoryOriginFields {
  origin_repo?: string | null;
  origin_branch?: string | null;
  origin_commit?: string | null;
  origin_pr?: number | null;
}

/** What kind of origin a link points at — drives the icon and the label. */
export type OriginLinkKind = 'pull-request' | 'branch' | 'commit' | 'repo';

export interface OriginLink {
  kind: OriginLinkKind;
  /** Short human label, e.g. `#482`, `feat/origin`, `abc1234`. */
  label: string;
  /** Absolute GitHub URL, or `null` when the repo is unknown (no link target). */
  url: string | null;
}

/** Same conservative `owner/name` shape the scope and origin validators use. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** How many leading characters of a SHA to show. Matches git's short form. */
export const SHORT_SHA_LENGTH = 7;

function repoOrNull(origin: MemoryOriginFields): string | null {
  const repo = origin.origin_repo?.trim();
  if (!repo || !REPO_RE.test(repo)) return null;
  return repo;
}

/** `https://github.com/owner/name`, or `null` when the repo is unknown/malformed. */
export function originRepoUrl(origin: MemoryOriginFields): string | null {
  const repo = repoOrNull(origin);
  return repo ? `https://github.com/${repo}` : null;
}

/** `…/pull/482`. Needs both the repo and the PR number. */
export function originPullRequestUrl(origin: MemoryOriginFields): string | null {
  const repo = repoOrNull(origin);
  const pr = origin.origin_pr;
  if (!repo || typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return null;
  return `https://github.com/${repo}/pull/${pr}`;
}

/**
 * `…/tree/<branch>`. Needs both the repo and the branch.
 *
 * Unlike `scopeRepoUrl`'s branch link, the branch is stored verbatim rather
 * than lowercased, so a mixed-case branch resolves instead of 404ing.
 */
export function originBranchUrl(origin: MemoryOriginFields): string | null {
  const repo = repoOrNull(origin);
  const branch = origin.origin_branch?.trim();
  if (!repo || !branch) return null;
  return `https://github.com/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

/** `…/commit/<sha>`. Needs both the repo and the SHA. */
export function originCommitUrl(origin: MemoryOriginFields): string | null {
  const repo = repoOrNull(origin);
  const commit = origin.origin_commit?.trim();
  if (!repo || !commit || !/^[0-9a-fA-F]{7,40}$/.test(commit)) return null;
  return `https://github.com/${repo}/commit/${commit.toLowerCase()}`;
}

/** The git short form of a SHA, for display. */
export function shortSha(commit: string): string {
  return commit.trim().slice(0, SHORT_SHA_LENGTH);
}

/**
 * The ordered set of links to render in the "Recorded from" block.
 *
 * Ordered most-specific first — the pull request is what a reader is usually
 * looking for, the repository is the weakest signal and is therefore only
 * included when nothing more specific is present (the scope already links the
 * repo in most cases, and a duplicate link is noise).
 */
export function originLinks(origin: MemoryOriginFields): OriginLink[] {
  const links: OriginLink[] = [];

  if (typeof origin.origin_pr === 'number' && origin.origin_pr >= 1) {
    links.push({
      kind: 'pull-request',
      label: `#${origin.origin_pr}`,
      url: originPullRequestUrl(origin),
    });
  }

  const branch = origin.origin_branch?.trim();
  if (branch) {
    links.push({ kind: 'branch', label: branch, url: originBranchUrl(origin) });
  }

  const commit = origin.origin_commit?.trim();
  if (commit) {
    links.push({ kind: 'commit', label: shortSha(commit), url: originCommitUrl(origin) });
  }

  const repo = origin.origin_repo?.trim();
  if (repo && links.length === 0) {
    links.push({ kind: 'repo', label: repo, url: originRepoUrl(origin) });
  }

  return links;
}
