// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/relevant.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';
import { RawScopeSchema } from './scope.ts';

/**
 * `GET /memories/relevant` — the one public verb that answers "which lessons
 * matter for this, right now".
 *
 * It exists because every other read makes the CALLER do the ranking.
 * `GET /memories` orders by `updated_at`, `POST /memories/search` orders by FTS
 * rank alone, and neither knows that a lesson written twelve times is worth
 * more than one written once. Each client that wanted a useful shortlist —
 * the SessionStart hook, the per-prompt hook, any agent — had to fetch a page
 * and sort it locally, which is three copies of a ranking and three chances to
 * disagree about it.
 *
 * The response is a COMPACT INDEX, not full rows: scope, key, a one-line hook,
 * and the score. Bodies stay one `memory.read` away. That is the same shape the
 * hooks inject, and it is deliberate — the value of this endpoint is deciding
 * WHICH few lessons are worth a reader's attention, and returning the full text
 * of ten of them would defeat the point by spending the context it just saved.
 */

/**
 * Query for `GET /memories/relevant`.
 *
 * `q` is optional. With it, relevance participates and the result is "what
 * matters for this task"; without it, the ranking is recency + salience and the
 * result is "what matters generally" — the SessionStart question. Making it
 * required would have forced the hook to invent a query for a session that has
 * not asked anything yet.
 */
export const RelevantQuerySchema = z.object({
  /**
   * Free-text query. Matched with Postgres `websearch` FTS over `key || value`,
   * the same index `POST /memories/search` uses — so a term that finds a lesson
   * there finds it here, and only the ORDER differs.
   */
  q: z.string().max(1000).optional(),
  /**
   * Comma-separated scopes, most-specific FIRST. The order is meaningful: it is
   * the precedence hierarchy, and it breaks ties between equally-scored
   * lessons so a project lesson wins over the global one it ties with. Omitted
   * → every scope the caller can see.
   */
  scopes: z.string().optional(),
  /**
   * How many lessons to return. Small by default and hard-capped: this is a
   * shortlist for a context window, and a caller asking for 100 "most relevant"
   * lessons wants `GET /memories` instead.
   */
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  /**
   * Drop hits scoring below this. `0` (the default) keeps everything the FTS
   * matched; raising it is how a caller says "stay silent rather than show me
   * something weak" — which is what a per-turn hook needs, since injecting an
   * irrelevant lesson on every prompt is worse than injecting nothing.
   *
   * Mind the floor this reaches today. When `q` is set every matched candidate
   * carries `relevance: 1` — relevance is binary here (see the handler's
   * docblock) — so with the endpoint's equal weights no matched score drops
   * below `1/3`, and a `min_score` at or under `0.333…` is therefore a no-op.
   * Above `1/3` it still discriminates, on recency and salience. A `min_score`
   * that gates across the whole range needs graded FTS relevance, which lands
   * with the ranked-relevance RPC (PR 11).
   */
  min_score: z.coerce.number().min(0).max(1).optional().default(0),
});
export type RelevantQuery = z.infer<typeof RelevantQuerySchema>;

/** One ranked lesson: enough to decide whether to read it, and no more. */
export const RelevantEntrySchema = z.object({
  scope: RawScopeSchema,
  key: z.string(),
  /** First meaningful line of the lesson, truncated on a word boundary. */
  hook: z.string(),
  /** Composite rank in [0,1]. Comparable within one response, not across. */
  score: z.number(),
  /** The three factors, so a caller can explain or re-weight a ranking. */
  factors: z.object({
    recency: z.number(),
    salience: z.number(),
    relevance: z.number(),
  }),
  seen_count: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});
export type RelevantEntry = z.infer<typeof RelevantEntrySchema>;

export const RelevantResponseSchema = z.object({
  entries: z.array(RelevantEntrySchema),
  /**
   * How many candidates were RANKED to produce `entries` — the fetched set, not
   * the total the filters match. Lets a caller say "3 of 47 shown" and know
   * whether narrowing the query is worth it, the same reason the SessionStart
   * block reports its own truncation.
   *
   * It SATURATES at the route's candidate cap — `CANDIDATE_LIMIT`, declared in
   * the handler and deliberately not restated here: this package cannot import
   * across the edge boundary, so a literal copied into this docblock would go
   * stale the day the cap moves. A response whose `candidates` equals the cap
   * means "at least that many matched", never "exactly that many" — read it as
   * a floor, not a total. An exact total would cost a second full count on
   * every request, which is the cost the cap exists to avoid.
   */
  candidates: z.number().int(),
});
export type RelevantResponse = z.infer<typeof RelevantResponseSchema>;

/**
 * The projection this route selects. Deliberately NOT `MEMORY_SELECT`: that one
 * carries `value` in full plus the `orgs(...)` embed, and this route reads the
 * value only to derive a one-line hook from it. Selecting the wide row for
 * every candidate — of which there may be many times the returned limit — would
 * move a lot of text out of Postgres to throw almost all of it away.
 */
export const RELEVANT_SELECT = 'scope,key,value,seen_count,updated_at,tags,origin_pr';

/** Cap on a lesson's one-line hook. Matches the CLI hook's `HOOK_LEN`. */
export const RELEVANT_HOOK_LEN = 80;

/**
 * A lesson's first meaningful line, cleaned into a short recognisable hook.
 *
 * Mirrors `lessonHook` in `packages/cli/src/core/lessons.mjs` — skips leading
 * HTML-comment metadata and markdown heading marks, collapses whitespace, and
 * truncates on a WORD boundary with an ellipsis so nothing is ever cut
 * mid-word into noise. It lives here, in the schema package, because the shape
 * of the response is part of the wire contract: a client rendering these lines
 * next to the hook-injected ones must not see two different styles of summary.
 */
export function lessonHook(value: unknown, max: number = RELEVANT_HOOK_LEN): string {
  let first = '';
  for (const raw of String(value ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--')) continue;
    first = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    if (first) break;
  }
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
