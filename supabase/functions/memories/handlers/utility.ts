import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { badRequest, forbidden, ok } from '../../_shared/api/respond.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope/scope.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import {
  LESSON_UTILITY_THRESHOLDS,
  UtilityQuerySchema,
  type LessonUtilityName,
  type UtilityCensus,
} from '../../_shared/schemas/memory.ts';

/**
 * The date read counting started — the SAME constant `/read-ranking` stamps,
 * for the same reason and from the same cutover.
 *
 * Duplicated rather than shared through a module because the two handlers are
 * independently deployable copies of one fact, and `read-ranking.ts` carries
 * the full derivation of the timestamp. A `0` in either response means "not
 * delivered since this date", never "never delivered".
 */
const COUNTING_SINCE = '2026-08-28T08:12:56.000Z';

/** Every quadrant name, so a census can be filled in even from a partial result. */
const UTILITY_NAMES: readonly LessonUtilityName[] = [
  'load-bearing',
  'specialist',
  'noise-tax',
  'dormant',
  'unproven',
];

interface RawCensusRow {
  utility: string;
  n: number;
}

interface RawUtilityRow {
  id: string;
  scope: string;
  key: string;
  read_count: number;
  opened_count: number;
  last_opened_at: string | null;
  created_at: string;
}

interface RawCostRow {
  delivered_reads: number;
  chosen_reads: number;
  delivered_tokens: number;
  chosen_tokens: number;
}

const EMPTY_COST: RawCostRow = {
  delivered_reads: 0,
  chosen_reads: 0,
  delivered_tokens: 0,
  chosen_tokens: 0,
};

/**
 * GET /memories/utility — every active lesson placed on the delivered ×
 * chosen grid, plus what the delivered half is costing in context.
 *
 * WHY IT IS NOT `/read-ranking` WITH A SORT. That route ranks by `read_count`
 * alone, and 99.80% of recorded reads are bulk ride-alongs in a
 * `memory.list`/`memory.search` page — so its ordering mostly encodes SCOPE
 * BREADTH, and its "cold" end nominates narrow scopes for pruning rather than
 * unused lore. Pull-through (`opened_count / read_count`, migration 00103) is
 * a proper fraction, so the breadth appears in both halves and cancels.
 *
 * TWO WINDOWS, DELIBERATELY, and both are reported so a client can caption
 * each: the census reads the LIFETIME counters on `memories` (the same two
 * columns the per-lesson chip reads, so a card and the grid cannot disagree),
 * while the cost sums `memory_read_daily` over the requested window (the only
 * source that can be windowed at all).
 *
 * REST-only by decision (`telemetry-vocabulary.ts`'s `NON_CATALOG_OPS`), the
 * tenth such read: the response names scopes and keys, and the agent-side
 * spelling already exists and is stronger — `memory.list` with
 * `max_opened_count => 0` (migration 00104) selects the actionable quadrants
 * over the WHOLE scope, where this only ranks a page.
 */
export async function handleUtility(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, UtilityQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  // Fail-LOUD on an ungrammatical scope, like every scope-bearing analytics
  // route — a scope filter IS the question, so a bad one is a 400 rather than
  // a silently-empty grid that reads as "you have no lore". And
  // `parseScopeFilter`, not the normalising `validateScope`, because the RPCs
  // compare `memories.scope`, which the REST write path stores VERBATIM: a
  // lowercased filter would place a mixed-case scope's lore in no quadrant at
  // all. `scope-filter-validation.spec.ts` pins that choice per handler.
  let scopeFilter: string | null = null;
  try {
    scopeFilter = parseScopeFilter(params.scope) ?? null;
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  const deniedScope = firstDeniedScope(auth, [scopeFilter]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  span.setAttributes({
    'lorekit.operation': 'memories.utility',
    ...(params.quadrant ? { 'lorekit.utility': params.quadrant } : {}),
    ...(scopeFilter ? { 'lorekit.scope': scopeFilter } : {}),
  });

  const tracedDb = createTracedClient(db, span);
  const userId = auth.userId ?? null;
  const keyScopes = keyRestriction(auth)?.scopes ?? [];
  // The thresholds travel from `@lorekit/schemas` INTO the RPC rather than
  // living in SQL, so the census and the dashboard's per-lesson chip are
  // computed from one set of numbers — see LESSON_UTILITY_THRESHOLDS.
  const thresholdArgs = {
    p_min_deliveries: LESSON_UTILITY_THRESHOLDS.minDeliveries,
    p_min_age_days: LESSON_UTILITY_THRESHOLDS.minAgeDays,
    p_chosen_pull_through: LESSON_UTILITY_THRESHOLDS.chosenPullThrough,
    p_broad_reach: LESSON_UTILITY_THRESHOLDS.broadReachDeliveries,
  };

  // Three independent reads, issued together: the census and the cost never
  // depend on each other, and the rows depend only on the requested quadrant.
  // Serialising them would triple the page's latency for no ordering benefit —
  // and the self-time ledger MERGES concurrent intervals, so the resulting
  // span reports the real wall clock rather than a tripled one.
  const [censusRes, costRes, rowsRes] = await Promise.all([
    tracedDb.rpc<RawCensusRow>('lorekit_memory_utility_census', {
      p_user_id: userId,
      p_scope: scopeFilter,
      p_key_scopes: keyScopes,
      ...thresholdArgs,
    }),
    tracedDb.rpc<RawCostRow>('lorekit_memory_delivery_cost', {
      p_user_id: userId,
      p_since: params.since ?? null,
      p_until: params.until ?? null,
      p_scope: scopeFilter,
      p_key_scopes: keyScopes,
    }),
    params.quadrant
      ? tracedDb.rpc<RawUtilityRow>('lorekit_memory_utility_rows', {
          p_user_id: userId,
          p_utility: params.quadrant,
          p_scope: scopeFilter,
          p_limit: params.limit,
          p_key_scopes: keyScopes,
          ...thresholdArgs,
        })
      : Promise.resolve({ data: [] as RawUtilityRow[], error: null }),
  ]);

  for (const res of [censusRes, costRes, rowsRes]) {
    if (res.error) {
      const message = (res.error as { message: string }).message;
      span.error(`DB: ${message}`);
      throw res.error;
    }
  }

  // Seeded with every name at 0, then filled: the RPC already returns all five,
  // so this is belt-and-braces against a partial result rather than the
  // authority. The invariant it protects is that a client never has to tell
  // "no lessons here" apart from "this key is missing".
  const census = Object.fromEntries(UTILITY_NAMES.map((n) => [n, 0])) as UtilityCensus;
  for (const row of (censusRes.data ?? []) as RawCensusRow[]) {
    if ((UTILITY_NAMES as readonly string[]).includes(row.utility)) {
      census[row.utility as LessonUtilityName] = Number(row.n);
    }
  }

  // `.rpc` on a `returns table` with one row hands back an array; an account
  // with no reads at all yields none, which is four zeroes, not an error.
  const costRows = (costRes.data ?? []) as RawCostRow[];
  const rawCost = costRows[0] ?? EMPTY_COST;

  const entries = ((rowsRes.data ?? []) as RawUtilityRow[]).map((r) => ({
    id: r.id,
    scope: r.scope,
    key: r.key,
    read_count: r.read_count,
    opened_count: r.opened_count,
    last_opened_at: r.last_opened_at,
    created_at: r.created_at,
  }));

  span.setAttributes({ 'lorekit.result_count': entries.length });

  return ok({
    thresholds: {
      min_deliveries: LESSON_UTILITY_THRESHOLDS.minDeliveries,
      min_age_days: LESSON_UTILITY_THRESHOLDS.minAgeDays,
      chosen_pull_through: LESSON_UTILITY_THRESHOLDS.chosenPullThrough,
      broad_reach_deliveries: LESSON_UTILITY_THRESHOLDS.broadReachDeliveries,
    },
    counting_since: COUNTING_SINCE,
    census,
    cost: {
      delivered_reads: Number(rawCost.delivered_reads),
      chosen_reads: Number(rawCost.chosen_reads),
      delivered_tokens: Number(rawCost.delivered_tokens),
      chosen_tokens: Number(rawCost.chosen_tokens),
    },
    window: { since: params.since ?? null, until: params.until ?? null },
    quadrant: params.quadrant ?? null,
    entries,
  }, cors);
}
