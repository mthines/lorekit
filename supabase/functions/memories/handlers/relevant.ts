import type { AuthContext } from '../../_shared/api/auth.ts';
import { forbidden, ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { RelevantQuerySchema, lessonHook } from '../../_shared/schemas/relevant.ts';
import { parseTagsParam } from '../../_shared/schemas/tags.ts';
import {
  rankLessons,
  selectDiverse,
  recencyFactor,
  salienceFactor,
  normalizeLexicalRank,
  normalizeRelevance,
  normalizeOutcome,
  seenCountFrom,
  updatedAtFrom,
} from '../../_shared/ranking/lesson-rank.ts';
import type { RankableLesson } from '../../_shared/ranking/lesson-rank.ts';
import { outcomeFromTags } from '../../_shared/ranking/outcome-signal.ts';

/**
 * One row of `lorekit_memory_relevant_candidates` (migration 00112) — the
 * `RELEVANT_SELECT` projection plus the graded `relevance`.
 *
 * `relevance` is the RAW, unbounded `ts_rank_cd` value, and `null` when the
 * request carried no `q`. Normalising it is this handler's job, not the RPC's:
 * the factor the scorer consumes has to be in [0,1], and where that mapping
 * lives has to be somewhere a unit test can pin it.
 */
interface RawRelevantCandidate {
  scope: string;
  key: string;
  value: string;
  seen_count: number | null;
  updated_at: string;
  tags: string[] | null;
  origin_pr: number | null;
  relevance: number | null;
}

/**
 * How many rows the candidate RPC may return before ranking. The ranking is
 * set-relative — salience normalises against the most-recurring candidate — so
 * it needs a population, not just the page it will return, or a genuinely
 * recurring lesson ranked 30th by relevance never gets the chance to come
 * first.
 *
 * Bounded because the cost is real: every candidate is fetched, scored and
 * mostly discarded. 200 is comfortably more than any `limit` this route accepts
 * (50) while staying one cheap indexed read.
 *
 * WHAT THE BOUND COSTS, now that migration 00112 cuts the window by rank. WITH
 * a `q` the cap is no longer an honesty problem: the RPC orders by
 * `ts_rank_cd` desc, so the rows that fall off the end are the ones that
 * matched WORST, which is the one population it is safe to discard. WITHOUT a
 * `q` there is no rank to order by and the window is still `updated_at desc`,
 * so on a store with more than `CANDIDATE_LIMIT` active rows an old lesson with
 * a high `seen_count` can still miss the set and salience cannot surface the
 * very row it exists for. That residue is real and deliberate: a global
 * salience order would need its own indexed ordering in the RPC, and the
 * no-`q` call is the SessionStart question, where recency is a defensible
 * window rather than an arbitrary one.
 */
const CANDIDATE_LIMIT = 200;

/**
 * `GET /memories/relevant` — top-K lessons ranked for a free-text query.
 *
 * THE POINT OF THE ROUTE is that ranking is a server concern. Every other read
 * hands the caller an ordering that is only one signal — `GET /memories` is
 * `updated_at` desc, `POST /memories/search` is FTS rank — and a caller wanting
 * a genuinely useful shortlist had to fetch a page and re-sort it. Three
 * clients doing that is three rankings that disagree.
 *
 * TWO PHASES, and the split is the design:
 *
 *   1. POSTGRES SELECTS AND GRADES the candidates, through
 *      `lorekit_memory_relevant_candidates` (migration 00112). FTS decides
 *      what could possibly be relevant, and it is the one part that must run in
 *      the database — an index scan over `fts` is the difference between
 *      reading 40 rows and reading the tenant's entire store. The RPC also
 *      returns HOW WELL each row matched (`ts_rank_cd`) and, when a `q` is
 *      present, cuts the candidate window in rank order rather than recency
 *      order.
 *   2. THE SHARED SCORER ORDERS them, in TypeScript, over the fetched set.
 *      Not SQL: the ranking is set-relative (salience is normalised against the
 *      most-recurring candidate) and it must agree exactly with the CLI hook's
 *      ordering. A second implementation in plpgsql could not be held to that
 *      agreement by any test, whereas `lesson-rank-parity.spec.ts` holds this
 *      one to the CLI's `lessons-pure.mjs` behaviourally.
 *
 * WHY AN RPC RATHER THAN THE POSTGREST QUERY IT REPLACES: `ts_rank_cd` is not
 * projectable through PostgREST's query grammar, so from the PostgREST side a
 * matched row could only ever score 1 and a non-matched row was never returned
 * — relevance was binary, and the candidate window was cut by recency, so the
 * best-matching lesson in a large store could fall outside it entirely. Both
 * are properties of the SELECT, so both are fixed in the SELECT.
 *
 * Relevance comes from the FTS side, so a query with no `q` legitimately ranks
 * on recency + salience alone — which is exactly the SessionStart question, and
 * why `q` is optional.
 *
 * DETERMINISTIC END TO END: `ts_rank_cd` is a pure Postgres function, the
 * candidate order is a total order (rank, then `updated_at`, then `id`), and
 * the scorer is pure. Identical request, identical rows, identical response —
 * no model and no vector index anywhere on the path.
 */
export async function handleRelevant(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, RelevantQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  // Most-specific first. The ORDER is meaningful — it is the precedence
  // hierarchy, and the scorer uses it to break ties — so `parseTagsParam` keeps
  // first-appearance order rather than sorting. It does trim each entry and drop
  // later duplicates (`normalizeTagList`), which cannot change the precedence a
  // caller expressed: a repeat only ever restates a rank already claimed.
  const scopes = parseTagsParam(params.scopes);

  span.setAttributes({
    'lorekit.operation': 'memories.relevant',
    ...(params.q ? { 'lorekit.query': params.q } : {}),
    'lorekit.limit': params.limit,
    'lorekit.scope_count': scopes.length,
  });

  // Early refusal for a NAMED scope outside the key's allowlist (00068/00069),
  // identical to `POST /memories/search`, which takes the same list shape.
  // Without it the RPC's `lorekit_api_token_scope_allowed` predicate narrows
  // the candidate set to empty, which reads as "there is nothing relevant
  // there" rather than "you may not ask about that scope". The refusal is not
  // redundant with that predicate — it is the difference between a 403 and a
  // misleading 200. EVERY named scope must be allowed, not just one:
  // answering over the allowed subset would answer a different question than
  // the one asked, and the precedence order the caller expressed would silently
  // lose a rank. `firstDeniedScope` returns null for a JWT/service caller and
  // for an unrestricted key, so an unscoped token is byte-for-byte unaffected.
  const deniedScope = firstDeniedScope(auth, scopes);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  const tracedDb = createTracedClient(db, span);

  // TENANCY IS RESOLVED INSIDE THE RPC, not layered on outside it. The
  // PostgREST form needed `getMemberOrgIds` + `applyRestTenantScope` here
  // because a service-role client bypasses RLS; the RPC composes the SAME three
  // functions those helpers mirror — `lorekit_member_org_ids` (00014),
  // `lorekit_api_token_org_allowed` and `lorekit_api_token_scope_allowed`
  // (00068/00069) — so the predicate is asked once, in SQL, for both auth
  // tiers. What travels from here is only the calling key's own restriction,
  // which lives on the token and nowhere else. That also drops a round trip:
  // the membership lookup is now a join inside the one query instead of a
  // separate RPC before it.
  const { data, error } = await tracedDb.rpc<RawRelevantCandidate>(
    'lorekit_memory_relevant_candidates',
    {
      p_user_id: auth.userId ?? null,
      // `|| null` rather than `?? null`: an EMPTY `q` is "no query", exactly as
      // the `if (params.q)` guard this replaces treated it. A non-empty query
      // whose every term is a stopword still goes through the FTS predicate and
      // still matches nothing — the RPC deliberately does not rescue it into
      // the unfiltered list.
      p_q: params.q || null,
      p_scopes: scopes,
      // The calling key's restriction (00068/00069), spelled exactly as every
      // other RPC-backed handler spells it. All THREE are required: `p_scopes`
      // narrows which scopes, `p_key_org_access`/`p_key_org_ids` narrow which
      // ORGS, and each defaults to the UNRESTRICTED value in SQL — so omitting
      // one does not fail, it fails OPEN.
      p_key_scopes: keyRestriction(auth)?.scopes ?? [],
      p_key_org_access: keyRestriction(auth)?.orgAccess ?? 'all',
      p_key_org_ids: keyRestriction(auth)?.orgIds ?? [],
      p_limit: CANDIDATE_LIMIT,
    },
  );
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as RawRelevantCandidate[];

  // RELEVANCE IS GRADED (migration 00112). `relevance` off the RPC is the raw
  // `ts_rank_cd` — unbounded above, and `null` when no `q` was asked — so it is
  // mapped onto the [0,1) factor `scoreLesson` consumes by
  // `normalizeLexicalRank`, a strictly increasing map that cannot reorder what
  // Postgres ranked. A `null` normalises to 0, which is byte-for-byte what the
  // no-`q` path scored before grading existed.
  const candidates: (RankableLesson & { scope: string; key: string; value: string })[] = rows.map((r) => ({
    scope: r.scope,
    key: r.key,
    value: r.value,
    seen_count: r.seen_count,
    updated_at: r.updated_at,
    relevance: normalizeLexicalRank(r.relevance),
    outcome: outcomeFromTags(r.tags, r.origin_pr),
  }));

  const now = Date.now();
  const ranked = rankLessons(candidates, { now, scopeOrder: scopes.length ? scopes : null });

  // The factors are recomputed for the response rather than threaded out of the
  // scorer, so the scorer's return shape stays minimal. `maxSeenCount` must be
  // the same population value it ranked against or the reported salience would
  // not reconcile with the score beside it.
  let maxSeenCount = 0;
  for (const c of candidates) maxSeenCount = Math.max(maxSeenCount, seenCountFrom(c));

  const filtered = ranked.filter((r) => r.score >= params.min_score);
  // MMR diversification (same as `order=rank` in the MCP `tools.ts` path): the
  // returned `entries` are ranked-then-diversified, so they are NOT strictly
  // score-descending — a more diverse lower-scored lesson can precede a
  // higher-scored near-duplicate. Clients must not assume score-monotonic order.
  const diverse = selectDiverse(filtered, params.limit);

  const entries = diverse
    .map(({ entry, score }) => ({
      scope: entry.scope,
      key: entry.key,
      hook: lessonHook(entry.value),
      score,
      factors: {
        recency: recencyFactor(updatedAtFrom(entry), now),
        salience: salienceFactor(seenCountFrom(entry), maxSeenCount),
        relevance: normalizeRelevance(entry.relevance),
        // `score` now averages a 4th factor. Reported so `factors` still
        // reconciles with `score` — an absent outcome surfaces as the
        // cold-start prior (`normalizeOutcome`), not a missing key.
        outcome: normalizeOutcome(entry.outcome),
      },
      seen_count: seenCountFrom(entry) || null,
      updated_at: entry.updated_at ?? null,
    }));

  span.setAttributes({
    'lorekit.result_count': entries.length,
    'lorekit.candidate_count': candidates.length,
  });

  // `candidates` is the RANKED population, so it saturates at CANDIDATE_LIMIT —
  // a value equal to the cap means "at least that many", never "exactly that
  // many". Stated against the constant rather than its literal so this comment
  // cannot go stale when the cap moves. The schema says the same on the field;
  // an exact total would need a second counting query per request, which is
  // precisely what the cap is there to avoid.
  const res = ok({ entries, candidates: candidates.length }, cors);
  // Let the router record the RECORD count, not just the call — see
  // RESULT_COUNT_HEADER in _shared/api/router.ts.
  res.headers.set('X-LoreKit-Result-Count', String(entries.length));
  return res;
}
