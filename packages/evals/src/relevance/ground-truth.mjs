// Ground truth for the retrieval-relevance eval, pinned to the REAL outcome
// signal — never a hand-authored label list.
//
// The question this file answers is: for a given query (a repository, optionally
// narrowed to one PR), which stored memories SHOULD a relevance-aware retriever
// surface? The spec pins that to the memories the loop machinery itself treats
// as outcome/relevance signal — the `loop::review-outcomes` bus and the
// `loop::reviewer-comment-relevance` signal — matched to the query's repo and
// weighted by how often they have recurred (`seen_count`).
//
// REUSE, NOT RE-ENCODING. The tag → bucket classification is owned by
// `@lorekit/schemas` and shipped to every write surface. This module imports it
// (`inferKindHost`) and NEVER re-encodes the literal `loop::…` strings. A copy
// here would keep passing while the product's bucket set moved underneath it —
// the single failure mode that would make every number this harness prints
// meaningless (see the package README, "Reuse, not re-implementation", and the
// recurring `mock-that-reimplements-the-thing-under-test` lesson). `AC-1-reuse`
// greps this file to prove the literals are absent and the import is present.
import { inferKindHost } from "@lorekit/schemas/tags";

/**
 * The recurrence threshold. A memory seen at least this many times is treated as
 * a confirmed, high-value signal (the same `seen_count >= 3` bar the promotion
 * loop uses). Below it a memory is still ground truth if it matches — recurrence
 * only WEIGHTS relevance, it does not gate membership — but it is not "confirmed".
 */
export const RECURRENCE_CONFIRMED_AT = 3;

/**
 * The two buckets the spec names as the outcome signal, identified by the
 * `{ kind, host }` the shipped resolver returns.
 *
 * HOST ALONE IS NOT ENOUGH. `inferKindHost` maps `loop::<host>-lessons` to that
 * host, so a plain `loop::reviewer-lessons` row also resolves to host
 * `reviewer` — it would clear a host-only check and pollute the ground truth
 * with ordinary lessons. The outcome buckets are the NON-lesson kinds: the
 * `bus` (`host: review`) and the `signal` (`host: reviewer`). Gating on the
 * pair keeps the classification owned by `@lorekit/schemas` while excluding
 * every `lesson` bucket, present or future.
 */
const OUTCOME_HOSTS = new Set(["review", "reviewer"]);
const OUTCOME_KINDS = new Set(["bus", "signal"]);

/**
 * Read a non-negative integer `seen_count` off a row in either shape the stores
 * hand back — the hosted projection uses `seenCount` (camel, via the CLI store's
 * `withReadFields`) and the raw REST/DB row uses `seen_count`. Absent or
 * unparseable → 0, never a throw: the bootstrap seed carries no count at all,
 * and a weight of 0 for it is correct AND is itself a placeholder tell.
 */
export function seenCountOf(row) {
  const raw = row?.seenCount ?? row?.seen_count;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * The `owner/repo` a scope names, or null. Handles `repo::owner/repo` and
 * `branch::owner/repo::branch`; a `global`/`project::…` scope names no repo.
 *
 * Deliberately a small structural read of an already-canonical scope string
 * rather than a re-implementation of scope VALIDATION — the rows come straight
 * from the store, so their scopes are already the canonical `::` form. The
 * validator (`@lorekit/core/src/scope.ts`) remains the authority on validity;
 * this only extracts the repo segment from a valid one.
 */
export function repoOfScope(scope) {
  if (typeof scope !== "string") return null;
  if (scope.startsWith("repo::")) return scope.slice("repo::".length) || null;
  if (scope.startsWith("branch::")) {
    return scope.slice("branch::".length).split("::")[0] || null;
  }
  return null;
}

/**
 * The `owner/repo` a query is about. A query may pass `repo` directly
 * (`mthines/lorekit`) or a full `scope` string to extract it from.
 */
export function repoOfQuery(query = {}) {
  if (typeof query.repo === "string" && query.repo) return query.repo;
  return repoOfScope(query.scope);
}

/**
 * Does this row belong to the ground-truth set for this query?
 *
 * A row qualifies iff BOTH hold:
 *   1. its tags resolve (via the shipped `inferKindHost`) to an outcome/relevance
 *      bucket — `kind` ∈ {bus, signal} AND `host` ∈ {review, reviewer}. The kind
 *      half is load-bearing: a `loop::reviewer-lessons` row resolves to host
 *      `reviewer` too, and a host-only check would admit it; and
 *   2. it matches the query repo. Match is a DISJUNCTION, per the spec's
 *      "`origin_pr` / repo scope matches": the row's scope names the query repo,
 *      OR its `origin_repo` does. `origin_pr`, when the query pins one, further
 *      NARROWS but is never REQUIRED — mock row m06 carries a real
 *      `loop::review-outcomes` signal with `origin_pr: null`, and requiring a PR
 *      would silently drop it.
 *
 * Pure and total: a malformed row degrades to `false`, never a throw.
 */
export function shouldSurface(row, query = {}) {
  if (!row || typeof row !== "object") return false;

  const { kind, host } = inferKindHost(row.tags);
  if (!host || !OUTCOME_HOSTS.has(host)) return false;
  if (!kind || !OUTCOME_KINDS.has(kind)) return false;

  const wantRepo = repoOfQuery(query);
  if (wantRepo) {
    // A real disjunction, as documented: `??` would consult `origin_repo` ONLY
    // when the scope names no repo, so a row scoped to another repo but
    // ORIGINATING in this one was dropped outright — the opposite of "scope
    // matches OR origin_repo matches".
    const scopeRepo = repoOfScope(row.scope);
    const originRepo = typeof row.origin_repo === "string" ? row.origin_repo : null;
    if (scopeRepo !== wantRepo && originRepo !== wantRepo) return false;
  }

  // A PR pin narrows only when the row actually declares one; a null-PR row is
  // kept (see the m06 rationale above).
  if (query.origin_pr != null && row.origin_pr != null) {
    if (row.origin_pr !== query.origin_pr) return false;
  }

  return true;
}

/**
 * The relevance weight of a ground-truth row: its `seen_count`, with a small
 * confirmed-bump so a recurrence-confirmed row always outranks an unconfirmed
 * one even when both have low raw counts. Non-members weigh 0.
 *
 * The weight exists so a retriever's ranking can be scored against a graded
 * ideal, and so the placeholder seed (all weight 0) is visibly distinguishable
 * from a real hosted snapshot (non-zero counts).
 */
export function relevanceWeight(row, query = {}) {
  if (!shouldSurface(row, query)) return 0;
  const seen = seenCountOf(row);
  return seen >= RECURRENCE_CONFIRMED_AT ? seen + 1000 : seen;
}

/**
 * Build the ground-truth set for a query from a list of stored rows.
 *
 * Returns the members as lightweight, METADATA-ONLY entries (no lesson body ever
 * enters this structure) plus the ordered key list a metrics pass consumes.
 *
 * @param {object[]} rows  stored memories (mock rows, or `mine`'d hosted rows)
 * @param {object}   query { repo?, scope?, origin_pr? }
 * @returns {{ query: object, keys: string[],
 *            entries: Array<{ scope, key, tags, origin_pr, seenCount,
 *                             weight, recurrenceConfirmed }> }}
 */
export function buildGroundTruth(rows = [], query = {}) {
  const entries = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!shouldSurface(row, query)) continue;
    const seenCount = seenCountOf(row);
    entries.push({
      scope: row.scope ?? null,
      key: row.key ?? null,
      tags: Array.isArray(row.tags) ? [...row.tags] : [],
      origin_pr: row.origin_pr ?? null,
      seenCount,
      weight: relevanceWeight(row, query),
      recurrenceConfirmed: seenCount >= RECURRENCE_CONFIRMED_AT,
    });
  }
  // Highest weight first, then key for a stable order — the ideal ranking a
  // retriever is scored against.
  entries.sort(
    (a, b) => b.weight - a.weight || String(a.key).localeCompare(String(b.key)),
  );
  return {
    query,
    keys: entries.map((e) => e.key).filter((k) => typeof k === "string"),
    entries,
  };
}
