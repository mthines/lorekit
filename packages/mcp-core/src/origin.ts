// Optional origin (provenance) parameters for memory.write.
//
// A memory's `scope` says WHERE the lesson applies (`repo::owner/name`,
// `branch::owner/name::branch`, …). It does not say where the lesson CAME
// FROM: a `global` lesson can be learned while reviewing a pull request, and a
// `repo::`-scoped lesson says nothing about which branch, commit, or PR taught
// it. The origin fields close that gap so the dashboard can render a
// "Recorded from" block that links straight back to the branch / PR / commit.
//
// Four narrow, independently-optional fields rather than a free-form blob:
//   origin_repo    owner/name of the repository the write happened in
//   origin_branch  the git branch the write happened on
//   origin_commit  the commit SHA that was checked out
//   origin_pr      the pull request number the work belonged to
//
// `parseOrigin` is the single, pure validation gate for all four. It is
// mirrored self-contained into the Deno edge tree
// (supabase/functions/_shared/origin.ts — `_shared/` because BOTH the MCP
// tools and the REST `POST /memories` handler validate through it), the same
// pattern as created-at.ts and ttl.ts. Keep the two copies behaviourally
// identical; the vitest suite here is the shared guard.
//
// Why the charsets are strict: these values are interpolated into GitHub URLs
// in the dashboard and are echoed back over the API, so they are constrained to
// the same conservative character sets the scope validator uses. Anything that
// does not match is REJECTED rather than silently dropped — a wrong origin link
// is worse than no origin link.

export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginError';
  }
}

/** `owner/name`. Same charset as the repo half of a `repo::` scope. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** Git branch names. Same charset as the branch half of a `branch::` scope. */
const BRANCH_RE = /^[\w./-]+$/;
/** Abbreviated (>= 7) up to full (40) hex commit SHA. */
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

export const ORIGIN_REPO_MAX = 140;
export const ORIGIN_BRANCH_MAX = 255;
/** Postgres `integer` ceiling — origin_pr is stored as int4. */
export const ORIGIN_PR_MAX = 2_147_483_647;

/** A validated, normalised origin. Every field is independently optional. */
export interface MemoryOrigin {
  repo: string | null;
  branch: string | null;
  commit: string | null;
  pr: number | null;
}

/** The raw, unvalidated write-tool parameters. */
export interface OriginInput {
  origin_repo?: unknown;
  origin_branch?: unknown;
  origin_commit?: unknown;
  origin_pr?: unknown;
}

/** An origin with nothing set — the result for a write that supplied none. */
export const EMPTY_ORIGIN: MemoryOrigin = Object.freeze({
  repo: null,
  branch: null,
  commit: null,
  pr: null,
});

/** True when at least one origin field is populated. */
export function hasOrigin(origin: MemoryOrigin): boolean {
  return origin.repo !== null || origin.branch !== null || origin.commit !== null || origin.pr !== null;
}

function optionalString(input: unknown, paramName: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new OriginError(`${paramName} must be a string`);
  }
  const trimmed = input.trim();
  // An empty string is how an unset shell variable reaches us (`--origin-branch
  // "$BRANCH"` with BRANCH unset). Treat it as "not supplied" rather than as a
  // validation failure, so callers can pass ambient values unconditionally.
  return trimmed === '' ? null : trimmed;
}

/** Validate and normalise `origin_repo` to a lowercase `owner/name`. */
export function parseOriginRepo(input: unknown): string | null {
  const value = optionalString(input, 'origin_repo');
  if (value === null) return null;
  if (value.length > ORIGIN_REPO_MAX) {
    throw new OriginError(`origin_repo must be <= ${ORIGIN_REPO_MAX} characters`);
  }
  const lowered = value.toLowerCase();
  if (!REPO_RE.test(lowered)) {
    throw new OriginError(`origin_repo must be "owner/name": ${value}`);
  }
  return lowered;
}

/**
 * Validate `origin_branch`.
 *
 * Deliberately NOT lowercased: unlike a `branch::` scope (which is canonically
 * lowercased and therefore produces `/tree/` links that 404 on a mixed-case
 * branch), the origin branch is stored verbatim so its GitHub link resolves.
 */
export function parseOriginBranch(input: unknown): string | null {
  const value = optionalString(input, 'origin_branch');
  if (value === null) return null;
  if (value.length > ORIGIN_BRANCH_MAX) {
    throw new OriginError(`origin_branch must be <= ${ORIGIN_BRANCH_MAX} characters`);
  }
  if (!BRANCH_RE.test(value)) {
    throw new OriginError(`origin_branch contains unsupported characters: ${value}`);
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('..')) {
    throw new OriginError(`origin_branch is not a valid git ref: ${value}`);
  }
  return value;
}

/** Validate and normalise `origin_commit` to a lowercase hex SHA. */
export function parseOriginCommit(input: unknown): string | null {
  const value = optionalString(input, 'origin_commit');
  if (value === null) return null;
  const lowered = value.toLowerCase();
  if (!COMMIT_RE.test(lowered)) {
    throw new OriginError(`origin_commit must be a 7-40 character hex SHA: ${value}`);
  }
  return lowered;
}

/** Validate and normalise `origin_pr` to a positive integer. */
export function parseOriginPr(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'string' && input.trim() === '') return null;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) {
    throw new OriginError('origin_pr must be a finite number');
  }
  if (!Number.isInteger(n)) {
    throw new OriginError('origin_pr must be an integer');
  }
  if (n < 1) {
    throw new OriginError('origin_pr must be >= 1');
  }
  if (n > ORIGIN_PR_MAX) {
    throw new OriginError(`origin_pr must be <= ${ORIGIN_PR_MAX}`);
  }
  return n;
}

/**
 * Validate and normalise the four optional origin write parameters.
 *
 * @returns a fully-populated {@link MemoryOrigin} where every unsupplied field
 *   is `null` (the RPC then leaves the stored value untouched).
 * @throws {OriginError} when a supplied value is malformed.
 */
export function parseOrigin(input: OriginInput): MemoryOrigin {
  return {
    repo: parseOriginRepo(input.origin_repo),
    branch: parseOriginBranch(input.origin_branch),
    commit: parseOriginCommit(input.origin_commit),
    pr: parseOriginPr(input.origin_pr),
  };
}
