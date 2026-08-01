/**
 * Memory origin (provenance) — "recorded from" link derivation.
 *
 * A memory's `scope` says WHERE the lesson applies; `lib/scope.ts`'s
 * `scopeRepoUrl` derives a repo link from it. The origin columns (migration
 * 00048) say where the lesson was RECORDED FROM — the repo, branch, commit,
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

import { scopeRepoRef } from './scope';

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
 * **Complements the scope, never repeats it.** The Metadata list already has a
 * "Repo" row derived from the scope (`scopeRepoUrl`) — that row answers "where
 * does this lesson APPLY". Passing the memory's `scope` here makes this
 * function emit only what that row cannot already say:
 *
 * - the **repo** row appears only when the scope does NOT already name the same
 *   repository — i.e. for a `global` / `project` lesson (whose scope names no
 *   repo at all), or when the lesson was recorded in a DIFFERENT repo than the
 *   one it applies to. Same repo ⇒ suppressed, because the "Repo" row above is
 *   already that link.
 * - the **branch** row is suppressed when a `branch::` scope already names the
 *   same branch of the same repo — that scope's "Repo" row links `/tree/<branch>`.
 * - **pull request** and **commit** are always kept: no scope can express them.
 *
 * Omitting the `scope` argument disables the suppression and returns every
 * known origin (the standalone view — nothing else on screen carries the repo).
 *
 * Order is context-first: repo (when it adds information) → pull request →
 * branch → commit.
 */
export function originLinks(origin: MemoryOriginFields, scope?: string): OriginLink[] {
  const links: OriginLink[] = [];
  const scoped = scope ? scopeRepoRef(scope) : { repo: null, branch: null };
  const repo = origin.origin_repo?.trim();
  const sameRepo = Boolean(repo && scoped.repo && repo.toLowerCase() === scoped.repo.toLowerCase());

  // Repo — only when the scope doesn't already put the same link on screen.
  if (repo && !sameRepo) {
    links.push({ kind: 'repo', label: repo, url: originRepoUrl(origin) });
  }

  if (typeof origin.origin_pr === 'number' && origin.origin_pr >= 1) {
    links.push({
      kind: 'pull-request',
      label: `#${origin.origin_pr}`,
      url: originPullRequestUrl(origin),
    });
  }

  const branch = origin.origin_branch?.trim();
  // A `branch::` scope's Repo row already links this exact branch — but only
  // when it is the same repo; the same branch NAME in another repo is a
  // different branch and must still be shown.
  const branchInScope =
    sameRepo && Boolean(scoped.branch && branch && scoped.branch.toLowerCase() === branch.toLowerCase());
  if (branch && !branchInScope) {
    links.push({ kind: 'branch', label: branch, url: originBranchUrl(origin) });
  }

  const commit = origin.origin_commit?.trim();
  if (commit) {
    links.push({ kind: 'commit', label: shortSha(commit), url: originCommitUrl(origin) });
  }

  return links;
}
