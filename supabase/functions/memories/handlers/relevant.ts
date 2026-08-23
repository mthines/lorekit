import type { AuthContext } from '../../_shared/api/auth.ts';
import { forbidden, ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { TracedQuery, Span } from '../../_shared/telemetry/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope, firstDeniedScope } from '../../_shared/api/tenant.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import {
  RelevantQuerySchema,
  RELEVANT_SELECT,
  lessonHook,
} from '../../_shared/schemas/relevant.ts';
import { parseTagsParam } from '../../_shared/schemas/tags.ts';
import {
  rankLessons,
  selectDiverse,
  recencyFactor,
  salienceFactor,
  normalizeRelevance,
  normalizeOutcome,
  seenCountFrom,
  updatedAtFrom,
} from '../../_shared/ranking/lesson-rank.ts';
import type { RankableLesson } from '../../_shared/ranking/lesson-rank.ts';
import { outcomeFromTags } from '../../_shared/ranking/outcome-signal.ts';

type MemoryRow = Tables<'memories'>;

/**
 * How many rows the FTS may return before ranking. The ranking is set-relative
 * — salience normalises against the most-recurring candidate — so it needs a
 * population, not just the page it will return, or a genuinely recurring lesson
 * ranked 30th by FTS never gets the chance to come first.
 *
 * Bounded because the cost is real: every candidate is fetched, scored and
 * mostly discarded. 200 is comfortably more than any `limit` this route accepts
 * (50) while staying one cheap indexed read.
 *
 * AND THE HONEST LIMIT THE BOUND BUYS: the window is cut in `updated_at desc`
 * order, NOT by rank. On a store with more than `CANDIDATE_LIMIT` active rows
 * matching the filters — most acutely with no `q`, where the filters are just
 * "active" — an old lesson with a high `seen_count` never enters the set, so
 * salience cannot surface the very row it exists for. It is a recency-windowed
 * ranking, not a global one. Widening the cap only moves the cliff; removing it
 * needs the candidates chosen by rank in Postgres, which is the same `ts_rank`
 * RPC graded relevance needs (see the relevance note below) and belongs there.
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
 *   1. POSTGRES SELECTS the candidates. FTS decides what could possibly be
 *      relevant, and it is the one part that must run in the database — an
 *      index scan over `fts` is the difference between reading 40 rows and
 *      reading the tenant's entire store.
 *   2. THE SHARED SCORER ORDERS them, in TypeScript, over the fetched set.
 *      Not SQL: the ranking is set-relative (salience is normalised against the
 *      most-recurring candidate) and it must agree exactly with the CLI hook's
 *      ordering. A second implementation in plpgsql could not be held to that
 *      agreement by any test, whereas `lesson-rank-parity.spec.ts` holds this
 *      one to the CLI's `lessons-pure.mjs` behaviourally.
 *
 * Relevance comes from the FTS side, so a query with no `q` legitimately ranks
 * on recency + salience alone — which is exactly the SessionStart question, and
 * why `q` is optional.
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
  // Without it `applyRestTenantScope` narrows the candidate set to empty, which
  // reads as "there is nothing relevant there" rather than "you may not ask
  // about that scope". EVERY named scope must be allowed, not just one:
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

  let q: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .select(RELEVANT_SELECT)
    // Active lore only — the same partition every read path applies. An
    // archived or expired lesson is not a candidate for "what should I read".
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    // A deterministic order over the CANDIDATE fetch. It is not the answer's
    // order (the scorer decides that), but without it the set of rows that
    // survives the cap would vary between identical requests, which would make
    // the endpoint non-deterministic in a way no caller could see.
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CANDIDATE_LIMIT);

  // api_key auth uses the service-role client (bypasses RLS) — apply the tenant
  // filter. JWT auth is RLS-scoped and needs none. Identical to every sibling
  // read route; there is no second predicate here to drift from them.
  if (auth.type === 'api_key' && auth.userId) {
    const orgIds = await getMemberOrgIds(db, auth.userId, span);
    q = applyRestTenantScope(q, auth.userId, orgIds, keyRestriction(auth));
  }

  if (params.q) q = q.textSearch('fts', params.q, { type: 'websearch', config: 'english' });
  if (scopes.length) q = q.in('scope', scopes);

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as MemoryRow[];

  // RELEVANCE IS BINARY HERE, AND THAT IS AN HONEST LIMIT RATHER THAN AN
  // OVERSIGHT. `ts_rank` is not projectable through PostgREST's query grammar,
  // so a row that matched the FTS predicate scores 1 and — since a non-matching
  // row was never returned — nothing scores between. The ordering among matches
  // is therefore decided by recency and salience, which is the useful half:
  // "these all mention your terms, here are the ones that keep mattering". A
  // graded relevance needs an RPC returning `ts_rank`, which is PR 11's
  // territory (it has to happen there anyway for the semantic fusion).
  const matched = Boolean(params.q);
  const candidates: (RankableLesson & { scope: string; key: string; value: string })[] = rows.map((r) => ({
    scope: r.scope,
    key: r.key,
    value: r.value,
    seen_count: (r as MemoryRow & { seen_count?: number }).seen_count ?? null,
    updated_at: r.updated_at,
    relevance: matched ? 1 : 0,
    outcome: outcomeFromTags(
      (r as MemoryRow & { tags?: string[] | null }).tags,
      (r as MemoryRow & { origin_pr?: number | null }).origin_pr,
    ),
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
