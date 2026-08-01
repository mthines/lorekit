// Derive a memory's ORIGIN — where a lesson is being recorded FROM — from the
// git working directory and the ambient CI environment.
//
// This is the counterpart to `scope.mjs`'s `deriveScope()`. A scope says where
// a lesson APPLIES; an origin says where it was written: the repository, the
// branch, the checked-out commit, and the pull request the work belonged to.
// The dashboard renders it as a "recorded from" block with links straight back
// to the PR, branch, and commit (migration 00048).
//
// Nothing here is required: every field independently degrades to `null` when
// it cannot be determined (no git, detached HEAD, no PR context), and a write
// with no origin at all behaves exactly as it did before this existed.
//
// Zero-dependency, and deliberately injectable (`{ cwd, env, run }`) so the
// whole derivation is testable without a real repository or a real CI runner.
import { execFileSync } from 'node:child_process';
import { ownerRepoFromRemote } from './scope.mjs';

function gitRunner(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Extract a pull request number from the ambient environment.
 *
 * Precedence, first match wins:
 *   1. LOREKIT_PR              — the explicit escape hatch, any CI or none.
 *   2. GITHUB_REF              — `refs/pull/<n>/merge` on a GitHub Actions
 *                                `pull_request` run.
 *   3. GITHUB_PR_NUMBER        — set by several popular actions.
 *
 * Returns a positive integer, or `null` when no PR context is present.
 */
export function prNumberFromEnv(env = process.env) {
  const explicit = toPositiveInt(env.LOREKIT_PR);
  if (explicit !== null) return explicit;

  const ref = typeof env.GITHUB_REF === 'string' ? env.GITHUB_REF : '';
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  if (m) {
    const n = toPositiveInt(m[1]);
    if (n !== null) return n;
  }

  return toPositiveInt(env.GITHUB_PR_NUMBER);
}

function toPositiveInt(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Whether a string is a usable git ref name, per git-check-ref-format.
 *
 * A deny list, deliberately: a branch is whatever a contributor named it, and
 * `feat/add+x` / `fix/issue#123` / `feat/café` are all legal. The canonical
 * rule lives in `packages/mcp-core/src/origin.ts` (`parseOriginBranch`); this
 * is the zero-dependency CLI copy, kept behaviourally identical so a branch the
 * CLI derives is never one the server would reject.
 */
export function isValidRef(value) {
  if (typeof value !== 'string' || value === '') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/.test(value)) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.startsWith('.') || value.endsWith('.')) return false;
  if (value.endsWith('.lock')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false;
  return value.length <= 255;
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Derive `{ origin_repo, origin_branch, origin_commit, origin_pr }` for the
 * current working directory.
 *
 * Branch resolution prefers `GITHUB_HEAD_REF` over `git rev-parse`: on a
 * GitHub Actions `pull_request` run the checkout is a detached merge commit,
 * so git reports `HEAD` while `GITHUB_HEAD_REF` holds the real source branch.
 *
 * The branch is NOT lowercased (unlike a `branch::` scope) so the GitHub
 * `/tree/` link the dashboard builds from it resolves for a mixed-case branch.
 *
 * @returns an object whose four fields are each a value or `null`.
 */
export function deriveOrigin({ cwd = process.cwd(), env = process.env, run = gitRunner } = {}) {
  const remote = run(['config', '--get', 'remote.origin.url'], cwd);
  const gitBranch = run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

  // On a GitHub Actions `pull_request` run the checkout is a DETACHED MERGE
  // COMMIT of the head branch into the base, so `HEAD` (and `GITHUB_SHA`) name
  // a commit that exists on neither branch. Since the branch below deliberately
  // reports `GITHUB_HEAD_REF` — the real source branch — taking the merge SHA
  // here would have the two fields describe different refs.
  //
  // The head commit is the merge commit's SECOND parent. A shallow checkout
  // (actions/checkout's default `fetch-depth: 1`) does not have it, in which
  // case we record NO commit: an absent field is honest, a mismatched one is
  // worse than nothing.
  const onMergeCheckout = Boolean(firstNonEmpty(env.GITHUB_HEAD_REF));
  const gitCommit = onMergeCheckout
    ? run(['rev-parse', 'HEAD^2'], cwd)
    : run(['rev-parse', 'HEAD'], cwd);

  const repo = ownerRepoFromRemote(remote) ?? firstNonEmptyRepo(env);
  const branchRaw = firstNonEmpty(env.LOREKIT_BRANCH, env.GITHUB_HEAD_REF, gitBranch);
  // A derived branch that the server would reject is dropped here rather than
  // sent: provenance is decoration, and it must never fail the write it is
  // decorating.
  const branch = branchRaw && branchRaw !== 'HEAD' && isValidRef(branchRaw) ? branchRaw : null;
  // GITHUB_SHA is only a safe fallback OFF a merge checkout — on one it is the
  // merge commit, the very value the branch above exists to avoid.
  const commitRaw = onMergeCheckout
    ? firstNonEmpty(env.LOREKIT_COMMIT, gitCommit)
    : firstNonEmpty(env.LOREKIT_COMMIT, gitCommit, env.GITHUB_SHA);
  const commit = commitRaw && /^[0-9a-fA-F]{7,40}$/.test(commitRaw) ? commitRaw.toLowerCase() : null;

  return {
    origin_repo: repo,
    origin_branch: branch,
    origin_commit: commit,
    origin_pr: prNumberFromEnv(env),
  };
}

// `GITHUB_REPOSITORY` is `owner/name` already; it is the fallback for a CI
// checkout with no `origin` remote configured.
function firstNonEmptyRepo(env) {
  const raw = firstNonEmpty(env.LOREKIT_REPO, env.GITHUB_REPOSITORY);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  return /^[\w.-]+\/[\w.-]+$/.test(normalized) ? normalized : null;
}

/**
 * Merge a derived origin under caller-supplied overrides, dropping null fields.
 *
 * An explicitly supplied value always wins; a field neither supplied nor
 * derivable is omitted entirely rather than sent as `null`, so the server's
 * "keep the last KNOWN origin" upsert rule never erases a previously recorded
 * value.
 */
export function mergeOrigin(derived = {}, overrides = {}) {
  const out = {};
  for (const field of ['origin_repo', 'origin_branch', 'origin_commit', 'origin_pr']) {
    const value = overrides[field] ?? derived[field] ?? null;
    if (value !== null && value !== undefined && value !== '') out[field] = value;
  }
  return out;
}
