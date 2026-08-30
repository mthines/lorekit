import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { badRequest, forbidden, ok } from '../../_shared/api/respond.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { validateScope } from '../../_shared/scope/scope.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { ReadRankingQuerySchema } from '../../_shared/schemas/memory.ts';

/**
 * The date `memory_read_daily`/`memories.read_count` STARTED counting
 * (migration 00084's production deploy). Stamped on every response so a
 * `cold`, `read_count: 0` row reads as "not read since this date", never
 * "never read" — a memory written before it may have been read plenty under
 * the old, uncounted regime. See `ReadRankingResponseSchema.counting_since`.
 *
 * This is migration 00084's real production cutover, replacing the placeholder
 * (2026-08-23, the migration's AUTHORING day) that shipped with the original
 * handler: 00084 first reached `main` — and so the deploy pipeline that
 * promotes to `deployed/api-production` — in `ac99e64`
 * (`Merge pull request #583 from mthines/feat/insights-page`) at
 * 2026-08-28T08:12:56Z. The five-day gap mattered: every `cold` row was
 * captioned "not read since 23 Aug" when nothing was counted before the 28th,
 * which overstates the evidence for exactly the rows this panel nominates for
 * pruning. The merge timestamp precedes the deploy it triggers by a few
 * minutes, so this is still marginally early — but minutes, not days, and the
 * merge is the one instant the repo can name exactly.
 */
const COUNTING_SINCE = '2026-08-28T08:12:56.000Z';

/** The raw shape `lorekit_memory_read_ranking` returns. */
interface RawReadRankingRow {
  id: string;
  scope: string;
  key: string;
  read_count: number;
  last_read_at: string | null;
  seen_count: number | null;
  created_at: string;
}

/**
 * GET /memories/read-ranking — memories ranked by how often they have
 * actually been READ (`memories.read_count`, migration 00084), not written.
 *
 * REST-only by decision (`telemetry-vocabulary.ts`'s `NON_CATALOG_OPS`): the
 * response names individual scopes, the same scope-leak surface as
 * `GET /memories/tags`/`/facets` — dashboard analytics, not an agent
 * primitive, and no agent loop has asked for a "what have I over-read"
 * capability the way it has for search or list.
 */
export async function handleReadRanking(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ReadRankingQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  // Same canonical, fail-LOUD validator every scope-bearing analytics route
  // uses (`GET /memories/read-activity`, `/activity`) — a scope filter IS the
  // question, so an ungrammatical one is a 400, not a silently-empty result.
  let scopeFilter: string | null = null;
  if (params.scope !== undefined) {
    try {
      scopeFilter = validateScope(params.scope);
    } catch (e) {
      return badRequest((e as Error).message, undefined, cors);
    }
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
    'lorekit.operation': 'memories.read-ranking',
    'lorekit.direction': params.direction,
    ...(scopeFilter ? { 'lorekit.scope': scopeFilter } : {}),
  });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<RawReadRankingRow>('lorekit_memory_read_ranking', {
    p_user_id: auth.userId ?? null,
    p_direction: params.direction,
    p_scope: scopeFilter,
    p_limit: params.limit,
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const entries = ((data ?? []) as RawReadRankingRow[]).map((r) => ({
    id: r.id,
    scope: r.scope,
    key: r.key,
    read_count: r.read_count,
    last_read_at: r.last_read_at,
    seen_count: r.seen_count ?? undefined,
    created_at: r.created_at,
  }));
  span.setAttributes({ 'lorekit.result_count': entries.length });
  return ok({ direction: params.direction, counting_since: COUNTING_SINCE, entries }, cors);
}
