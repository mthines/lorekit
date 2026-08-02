import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/database.types.ts';
import { ListFacetsQuerySchema, MemoryFacetSchema } from '../../_shared/schemas/memory.ts';
import { parseTagsParam } from '../../_shared/schemas/tags.ts';

type FacetRow = Database['public']['Functions']['lorekit_memory_facets']['Returns'][number];

/**
 * GET /memories/facets — every value the caller can filter by, per dimension,
 * with how many memories carry it.
 *
 * This is `GET /memories/tags` generalised to the five dimensions the Explorer's
 * filter menu grew: labels, agent, trigger, repo, branch, pull request. Each
 * one is another unbounded free-text column, so each would otherwise repeat the
 * row-cap bug 00039 and 00050 exist to fix — one grouped row per distinct value
 * is exact at any volume, a `select … limit N` plus a browser-side tally is not.
 *
 * One call rather than one per dimension because the menu's headline
 * affordance is cross-dimension type-ahead: typing `main` at the top level must
 * surface `Branch → main` before the user has chosen a dimension, which is only
 * possible if every dimension's values are already in hand. `?facets=` narrows
 * the response for the follow-up case (a menu already drilled into one
 * dimension refreshing just that one).
 *
 * Tenant scoping lives in the RPC (`lorekit_memory_facets`, migration 00052),
 * which composes `lorekit_member_org_ids` exactly as the memories RLS read
 * policies do — so, as with `handleTags` and `handleScopes`, there is
 * deliberately no `applyRestTenantScope` call: there is no query to scope, and
 * a second predicate would be a place for the two to drift.
 */
export async function handleFacets(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListFacetsQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const archived = validated.data.archived === 'true';

  // An unknown name in `?facets=` narrows to nothing rather than 400ing: the
  // param arrives from a hand-editable URL, and the same list is re-read on
  // every keystroke in the menu, so a typo must not take the page down.
  const requested = new Set(
    parseTagsParam(validated.data.facets).filter(
      (f) => MemoryFacetSchema.safeParse(f).success,
    ),
  );

  span.setAttributes({
    'lorekit.operation': 'memories.facets',
    'lorekit.archived': validated.data.archived,
    ...(requested.size ? { 'lorekit.facets': Array.from(requested).join(',') } : {}),
  });

  const tracedDb = createTracedClient(db, span);
  // Service-role callers have no user id; the RPC recognises a null p_user_id
  // from a service_role JWT as "no tenant filter", matching GET /memories.
  const { data, error } = await tracedDb.rpc<FacetRow>('lorekit_memory_facets', {
    p_user_id: auth.userId ?? null,
    p_archived: archived,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const facets = ((data ?? []) as FacetRow[])
    .filter((r) => requested.size === 0 || requested.has(r.facet))
    .map((r) => ({ facet: r.facet, value: r.value, count: Number(r.count) }));

  span.setAttributes({ 'lorekit.result_count': facets.length });
  return ok({ facets }, cors);
}
