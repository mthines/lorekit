import type { AuthContext } from '../../_shared/api/auth.ts';
import { badRequest, ok } from '../../_shared/api/respond.ts';
import { validateOptionalBody, validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/database.types.ts';
import {
  ListFacetsBodySchema,
  ListFacetsQuerySchema,
  MemoryFacetSchema,
} from '../../_shared/schemas/memory.ts';
import { dimensionsFromBody, dimensionsFromQuery } from '../../_shared/schemas/dimensions.ts';
import type { MemoryDimensions } from '../../_shared/schemas/dimensions.ts';
import { parseTagsParam } from '../../_shared/schemas/tags.ts';

type FacetRow = Database['public']['Functions']['lorekit_memory_facets']['Returns'][number];

/**
 * A facets request, decoded from either transport — the same arrangement
 * `list.ts` uses, and for the same reason: one function talks to the RPC, so
 * the two routes cannot count differently.
 */
interface FacetsInput {
  archived: boolean;
  /** What the caller NAMED, kept for the span attribute. */
  named: readonly string[];
  /** The subset the server recognises. */
  requested: Set<string>;
  narrowed: boolean;
  scope?: string | undefined;
  dimensions: MemoryDimensions;
}

/**
 * GET /memories/facets — every value the caller can filter by, per dimension,
 * with how many memories carry it.
 *
 * This is `GET /memories/tags` generalised to the eight dimensions the Explorer's
 * filter menu grew: labels, agent, trigger, kind, host, repo, branch, pull
 * request. Each
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
 * Tenant scoping lives in the RPC (`lorekit_memory_facets`, migrations 00052 /
 * 00057), which composes `lorekit_member_org_ids` exactly as the memories RLS
 * read policies do — so, as with `handleTags` and `handleScopes`, there is
 * deliberately no `applyRestTenantScope` call: there is no query to scope, and
 * a second predicate would be a place for the two to drift.
 *
 * Counts are DRILL-DOWN (00057): the caller's active filters are forwarded and
 * each dimension is counted with every OTHER one applied but not its own. Two
 * limits worth knowing — a value counting zero under the other filters emits no
 * row (as a null column value does), and `q` / `key` / `created_since` /
 * `created_until` are not mirrored, so under a search or date window a count is
 * an upper bound rather than the exact yield.
 */
async function runFacets(
  input: FacetsInput,
  auth: AuthContext,
  db: DbClient,
  span: Span,
  cors: Record<string, string>,
): Promise<Response> {
  const { archived, named, requested, narrowed, dimensions: d } = input;

  // The Explorer sends its selected scope here as well as to GET /memories, so
  // the filter-menu counts drill down with the list. The two must therefore
  // agree on what a scope IS: if this one kept an ungrammatical value while the
  // list rejected it, the menu would quietly answer a different question than
  // the rows beside it.
  //
  // It runs on the decoded input rather than in either entry point, so the
  // query and body transports cannot diverge on which scopes they accept.
  let scopeFilter: string | undefined;
  try {
    scopeFilter = parseScopeFilter(input.scope);
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  // The attribute reports what the CALLER asked for (`named`), not the
  // recognised subset (`requested`): with every named dimension unknown the
  // subset is empty, so a `?facets=nope` trace would be indistinguishable from
  // a recognised narrowing that matched no rows. Do not "tighten" this back.
  span.setAttributes({
    'lorekit.operation': 'memories.facets',
    'lorekit.archived': String(archived),
    ...(narrowed ? { 'lorekit.facets': named.join(',') } : {}),
  });

  // Empty → null = "not filtered", which is what the RPC's parameters mean.
  const list = (values: readonly string[]) => (values.length ? [...values] : null);

  const tracedDb = createTracedClient(db, span);
  // Service-role callers have no user id; the RPC recognises a null p_user_id
  // from a service_role JWT as "no tenant filter", matching GET /memories.
  const { data, error } = await tracedDb.rpc<FacetRow>('lorekit_memory_facets', {
    p_user_id: auth.userId ?? null,
    p_archived: archived,
    p_scope: scopeFilter ?? null,
    p_tags: list(d.tags.values),
    p_tags_mode: d.tags.mode,
    p_source_agent: list(d.source_agent.values),
    p_source_agent_mode: d.source_agent.mode,
    p_trigger: list(d.trigger.values),
    p_trigger_mode: d.trigger.mode,
    p_kind: list(d.kind.values),
    p_kind_mode: d.kind.mode,
    p_host: list(d.host.values),
    p_host_mode: d.host.mode,
    p_origin_repo: list(d.origin_repo.values),
    p_origin_repo_mode: d.origin_repo.mode,
    p_origin_branch: list(d.origin_branch.values),
    p_origin_branch_mode: d.origin_branch.mode,
    p_origin_pr: list(d.origin_pr.values),
    p_origin_pr_mode: d.origin_pr.mode,
    // Owner (00064): `personal` plus org slugs, resolved against member orgs
    // inside the RPC. A plain value list like the other dimensions.
    p_owner: list(d.owner.values),
    p_owner_mode: d.owner.mode,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const facets = ((data ?? []) as FacetRow[])
    .filter((r) => !narrowed || requested.has(r.facet))
    .map((r) => ({ facet: r.facet, value: r.value, count: Number(r.count) }));

  span.setAttributes({ 'lorekit.result_count': facets.length });
  return ok({ facets }, cors);
}

/** `GET /memories/facets` — the query-string form. */
export async function handleFacets(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListFacetsQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const q = validated.data;

  // An unknown name in `?facets=` narrows to nothing rather than 400ing: the
  // param arrives from a hand-editable URL, and the same list is re-read on
  // every keystroke in the menu, so a typo must not take the page down.
  //
  // "Named nothing" and "named only unknown dimensions" are DIFFERENT requests
  // and must not collapse into the same empty set: the first means every
  // dimension, the second means none. Keep the caller's intent (`named`)
  // separate from the recognised subset (`requested`), or `?facets=nope`
  // silently WIDENS to the whole catalog — the opposite of narrowing.
  const named = parseTagsParam(q.facets);
  const requested = new Set(named.filter((f) => MemoryFacetSchema.safeParse(f).success));

  return runFacets({
    archived: q.archived === 'true',
    named,
    requested,
    narrowed: named.length > 0,
    scope: q.scope,
    dimensions: dimensionsFromQuery(q),
  }, auth, db, span, cors);
}

/**
 * `POST /memories/facets` — the same catalog, over a JSON body.
 *
 * The menu passes the caller's whole filter bar so the counts drill down, which
 * means it hits `GET /memories`' 2048-character-per-dimension wall at exactly
 * the same width the list does. Fixing the list alone would leave the Explorer
 * loading its rows and failing to load the numbers beside them.
 *
 * `facets` is the closed `MemoryFacet` vocabulary here, so an unknown NAME is a
 * 400 rather than a narrowing — a JSON client builds the array from the enum,
 * where the query form's tolerance exists for a hand-typed URL.
 */
export async function handleFacetsPost(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = await validateOptionalBody(req, ListFacetsBodySchema, cors);
  if (!validated.ok) return validated.response;
  const b = validated.data;

  const named = b.facets ?? [];
  return runFacets({
    archived: b.archived,
    named,
    requested: new Set(named),
    narrowed: named.length > 0,
    scope: b.scope,
    dimensions: dimensionsFromBody(b),
  }, auth, db, span, cors);
}
