/**
 * The outcome signal — how a memory row's `tags` and `origin_pr` become the
 * `outcome` factor the lesson scorer consumes.
 *
 * WHY THIS IS A MODULE, since it is only a handful of lines: it was duplicated
 * VERBATIM in two edge paths that rank lessons — `GET /memories/relevant`
 * (`memories/handlers/relevant.ts`) and the MCP `memory.list order=rank` tool
 * (`mcp/tools.ts`) — kept in step by a "mirrors the same constant" comment and
 * nothing else. A comment is not a guard: the two could drift the day one of
 * them learned a third signal, and a divergence would silently rank the same
 * row differently on the two transports. Hoisting the tag list and the ladder
 * here makes the single definition the only one, so they cannot disagree.
 *
 * It stays SEPARATE from `lesson-rank.ts` on purpose. That module is the pure
 * scorer and knows nothing of the repo's schema — relevance and outcome both
 * arrive on the row already reduced to a number in [0,1]. This module is where
 * the repo-schema knowledge lives: it maps `tags` + `origin_pr` to that number.
 * Symmetric with how relevance is derived by the query (`ts_rank`) and handed
 * to the scorer, never computed inside it.
 *
 * Import-free so it can be mirrored verbatim into
 * `supabase/functions/_shared/outcome-signal.ts` (the Deno edge tree cannot
 * cross-import this Node package). `edge-parity.spec.ts` guards the two copies.
 */

/**
 * Outcome bus tags that indicate a lesson has a strong positive outcome
 * (applied a suggestion / resolved a review thread).
 */
export const OUTCOME_BUS_TAGS = ['loop::review-outcomes', 'loop::reviewer-comment-relevance'] as const;

/** Strong positive: the lesson sits on an outcome bus (applied/resolved). */
export const OUTCOME_BUS_SCORE = 1.0;

/** Weak positive: the lesson was carried to a PR but has no bus outcome yet. */
export const OUTCOME_ORIGIN_PR_SCORE = 0.75;

/**
 * Map a memory row's `tags` and `origin_pr` to an outcome score in [0,1], or
 * `undefined` when no outcome signal is present (the scorer's cold-start prior
 * will apply).
 *
 * Ladder (highest to lowest signal strength):
 *   1. Outcome-bus tag present → `OUTCOME_BUS_SCORE` (strong: applied/resolved)
 *   2. Non-null `origin_pr`     → `OUTCOME_ORIGIN_PR_SCORE` (weak: carried to a PR)
 *   3. Neither                  → `undefined` (cold: scorer applies the prior)
 *
 * Order matters: a bus tag wins over `origin_pr`.
 */
export function outcomeFromTags(
  tags: readonly string[] | null | undefined,
  originPr: number | null | undefined,
): number | undefined {
  const list: readonly string[] = Array.isArray(tags) ? tags : [];
  if (OUTCOME_BUS_TAGS.some((tag) => list.includes(tag))) return OUTCOME_BUS_SCORE;
  if (originPr != null) return OUTCOME_ORIGIN_PR_SCORE;
  return undefined;
}
