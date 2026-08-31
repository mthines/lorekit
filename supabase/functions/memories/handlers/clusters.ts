import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { badRequest, forbidden, ok } from '../../_shared/api/respond.ts';
import { applyRestTenantScope, firstDeniedScope, getMemberOrgIds } from '../../_shared/api/tenant.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope/scope.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span, TracedQuery } from '../../_shared/telemetry/otel.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { ClustersQuerySchema } from '../../_shared/schemas/memory.ts';
import { lessonHook } from '../../_shared/schemas/relevant.ts';
import {
  clusterDuplicatesBlocked,
  rankCandidates,
  resolveRecurrenceClass,
} from '../../_shared/clusters/duplicate-clusters.ts';

type MemoryRow = Tables<'memories'>;

/**
 * The columns clustering needs, and no more.
 *
 * `value` is unavoidable — it is what gets tokenized — and it is also the
 * expensive one, which is what bounds `CANDIDATE_LIMIT` below. Bodies never
 * leave the function: only `lessonHook`'s first line reaches the response.
 */
const CLUSTERS_SELECT = 'scope,key,value,seen_count,updated_at';

/**
 * How many rows may be fetched before clustering.
 *
 * Lower than `GET /relevant`'s 200 on purpose. Clustering is quadratic in the
 * worst case where ranking is linear, and every candidate's FULL BODY is
 * fetched to be tokenized, so this cap bounds both a transfer and a CPU cost
 * rather than just a transfer. The token-blocked sweep makes the realistic case
 * far cheaper than the bound, but the bound has to hold for the adversarial
 * case — a store where every lesson shares a common token — and 150 rows of
 * pairwise Jaccard is comfortably inside an edge invocation's budget.
 *
 * AND THE HONEST LIMIT THE BOUND BUYS, which the response documents to callers:
 * the window is cut in `updated_at desc` order, NOT by similarity. A genuine
 * duplicate pair whose members both sit outside the window is invisible, and no
 * threshold can recover it. So this route answers "what have I recently written
 * that duplicates something else recent", not "what are all the duplicates in
 * my store" — `lorekit dedupe`, which streams the whole scope, is the answer to
 * the second question and is why this route does not need to be. Widening the
 * cap only moves the cliff; removing it needs the clustering pushed into
 * Postgres, which is exactly what the design rejects (see the docblock below).
 */
const CANDIDATE_LIMIT = 150;

/**
 * `GET /memories/clusters` — groups of near-duplicate lessons, ranked as merge
 * candidates.
 *
 * ## READ-ONLY is the contract, not a phase
 *
 * The compile pipeline's rule is "never auto-compile, never auto-gate": deciding
 * that N near-duplicate lessons are really one entry is a human judgment. This
 * route surfaces and ranks the evidence and stops. There is deliberately no
 * companion merge route and no parameter that makes this one act — which is also
 * why it is a GET with `requires: 'read'`, records no audit event, and is
 * exempt from the dry-run contract by construction (it has nothing to dry-run).
 *
 * ## Two phases, and the split is the design
 *
 * Verbatim the arrangement `handleRelevant` documents, for the same reasons:
 *
 *   1. POSTGRES SELECTS the candidates. Deciding which rows are even in play —
 *      active, in scope, visible to this tenant — is an indexed read and must
 *      run in the database.
 *   2. THE SHARED CORE CLUSTERS them, in TypeScript, over the fetched set. NOT
 *      SQL: the clustering is set-relative in the strongest sense (union-find
 *      over candidate pairs), and it must agree exactly with what `lorekit
 *      dedupe` reports. A plpgsql copy could not be held to that agreement by
 *      any test, whereas `duplicate-clusters-parity.spec.ts` holds this one to
 *      the CLI's `lessons-view.mjs` behaviourally.
 *
 * That second point is the whole reason there is no migration in this feature.
 */
export async function handleClusters(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ClustersQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  // Fail LOUD, and reject-only. A scope filter IS the question here, so an
  // ungrammatical one is a 400 — answering with an empty cluster list would read
  // as "you have no duplicates there" rather than "that is not a scope". And
  // `parseScopeFilter`, not the normalising `validateScope`, because this
  // filters `memories.scope`, which the REST write path stores VERBATIM: a
  // lowercased filter would report a mixed-case scope as duplicate-free.
  // `scope-filter-validation.spec.ts` pins that choice per handler.
  let scopeFilter: string | undefined;
  try {
    scopeFilter = parseScopeFilter(params.scope);
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  // Early refusal for a NAMED scope outside the key's allowlist (00068/00069),
  // AFTER the grammar check, matching `list.ts`/`facets.ts`. Without it
  // `applyRestTenantScope` narrows the candidate set to empty, which reads as
  // "nothing is duplicated there" instead of "you may not ask about that scope".
  const deniedScope = firstDeniedScope(auth, [scopeFilter ?? null]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  span.setAttributes({
    'lorekit.operation': 'memories.clusters',
    'lorekit.threshold': params.threshold,
    'lorekit.limit': params.limit,
    ...(scopeFilter ? { 'lorekit.scope': scopeFilter } : {}),
  });

  const tracedDb = createTracedClient(db, span);

  let q: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .select(CLUSTERS_SELECT)
    // Active lore only — the partition every read path applies. An archived or
    // expired lesson is not a merge candidate; it is already retired.
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    // A deterministic order over the CANDIDATE fetch. It is not the answer's
    // order (the ranking decides that), but without it the set of rows that
    // survives the cap would vary between identical requests — and here that
    // would mean a cluster appearing and disappearing on refresh.
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

  if (scopeFilter) q = q.eq('scope', scopeFilter);

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as MemoryRow[];
  const entries = rows.map((r) => ({
    scope: r.scope,
    key: r.key,
    value: r.value,
    seenCount: (r as MemoryRow & { seen_count?: number | null }).seen_count ?? null,
    updatedAt: r.updated_at,
  }));

  const ranked = rankCandidates(clusterDuplicatesBlocked(entries, params.threshold), {
    minSeenCount: params.min_seen_count,
    resolveClass: resolveRecurrenceClass,
  });

  const clusters = ranked.slice(0, params.limit).map((cl) => ({
    size: cl.size,
    score: cl.score,
    min_similarity: cl.minSimilarity,
    max_similarity: cl.maxSimilarity,
    // `classId` is what makes the resolution real — a match with no class is the
    // null shape, so branching on it (rather than on `matched.length`) keeps the
    // response's nullability aligned with the core's own contract.
    recurrence_class: cl.recurrenceClass?.classId
      ? {
        id: cl.recurrenceClass.classId,
        name: cl.recurrenceClass.className ?? cl.recurrenceClass.classId,
        matched: cl.recurrenceClass.matched,
        pure: cl.recurrenceClass.pure,
      }
      : null,
    members: cl.members.map((m) => ({
      scope: m.scope,
      key: m.key,
      hook: lessonHook(m.value),
      seen_count: m.seenCount,
      updated_at: m.updatedAt,
      // Reported verbatim from the lesson's own meta comment, never validated
      // against a vocabulary — see `ClusterMemberSchema.status`.
      status: m.meta['status'] ?? null,
    })),
  }));

  span.setAttributes({
    'lorekit.result_count': clusters.length,
    'lorekit.candidate_count': entries.length,
  });

  const res = ok(
    { threshold: params.threshold, candidates: entries.length, clusters },
    cors,
  );
  // Let the router record the RECORD count, not just the call — the number of
  // CLUSTERS, matching how every other collection read reports what it returned.
  res.headers.set('X-LoreKit-Result-Count', String(clusters.length));
  return res;
}
