import type { AuthContext } from '../../_shared/api/auth.ts';
import { badRequest, ok } from '../../_shared/api/respond.ts';
import { validateOptionalBody, validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import type { SortColumn } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import {
  ListMemoriesBodySchema,
  ListMemoriesQuerySchema,
  shapeMemoryRow,
} from '../../_shared/schemas/memory.ts';
import { dimensionsFromBody, dimensionsFromQuery } from '../../_shared/schemas/dimensions.ts';
import type { MemoryDimensions } from '../../_shared/schemas/dimensions.ts';
import { likeNeedle } from '../../_shared/schemas/filter.ts';
import { expiringWindow } from '../../_shared/expiring-window.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

/**
 * The list read, decoded from EITHER transport.
 *
 * `GET /memories` and `POST /memories/list` differ only in how a request is
 * spelled — a query string, where every value is a string and every dimension
 * is comma-joined, or a JSON body, where they are real types and real arrays.
 * Both decode into this shape and both hand it to the SAME reader, so the two
 * routes cannot answer differently. That is the point: the body route exists
 * because a URL cannot carry an unbounded filter bar, not because the read
 * should behave differently.
 */
interface ListParams {
  scope?: string | undefined;
  key?: string | undefined;
  key_prefix?: string | undefined;
  q?: string | undefined;
  created_since?: string | undefined;
  created_until?: string | undefined;
  sort: SortColumn;
  archived: boolean;
  expiring_within_days?: number | undefined;
  limit: number;
  cursor?: string | undefined;
  dimensions: MemoryDimensions;
}

/**
 * One row as `lorekit_memory_list` returns it: the `memories` columns plus the
 * org embed FLATTENED into two scalars, because a SQL function returns a table
 * and not a nested document.
 */
type ListRpcRow = MemoryRow & { org_name: string | null; org_slug: string | null };

/**
 * Re-nest the flattened org columns so the response body is byte-identical to
 * the one the PostgREST path produced.
 *
 * `shapeMemoryRow` is the single place an embed becomes the API's `org` field,
 * and it is deliberately total — an absent or partial embed degrades to
 * `org: null`. Handing it the `orgs` shape it already understands keeps that
 * one definition rather than adding a second flattening rule here.
 */
function shapeRpcRow(row: ListRpcRow): Record<string, unknown> {
  const { org_name, org_slug, ...rest } = row;
  return shapeMemoryRow({
    ...rest,
    orgs:
      rest.org_id && org_name !== null && org_slug !== null
        ? { id: rest.org_id, name: org_name, slug: org_slug }
        : null,
  });
}

/**
 * Run a decoded list request and shape the keyset page. Shared by both routes.
 *
 * Reads through the `lorekit_memory_list` SQL function (00067) rather than
 * composing PostgREST filters, and that is the whole point of the migration:
 * postgrest-js puts every filter in a QUERY PARAM and issues a GET, so a
 * dimension carrying a few hundred values built an internal URL the gateway
 * refused — the same wall the body transport removed on the client hop, simply
 * relocated one hop downstream where it surfaced as an unattributable 500. An
 * RPC takes `text[]` parameters over a POST body, so the value set never
 * reaches a URL on either hop and the bound is a real bound rather than a
 * function of how long the values happen to be.
 *
 * Three values are resolved HERE and passed in already-computed, so each stays
 * encoded exactly once in this repo: the `q` and `key_prefix` LIKE needles
 * (`likeNeedle`) and the expiring-soon window (`expiringWindow`). Mirroring
 * either into plpgsql is the drift 00063 and 00066 both refuse.
 */
async function respondWithPage(
  params: ListParams,
  auth: AuthContext,
  db: DbClient,
  span: Span,
  cors: Record<string, string>,
): Promise<Response> {
  // `ListMemoriesQuerySchema.scope` / `ListMemoriesBodySchema.scope` are
  // `RawScopeSchema` (shape-only), so the canonical grammar runs here, where a
  // rejection can become a 400 — the rule `memories/CLAUDE.md` states and
  // `GET /memories/read-activity` already follows. A scope filter IS the
  // question; keeping an ungrammatical one and matching nothing answers a
  // different question and calls it empty. `parseScopeFilter` rejects without
  // normalising — see its docblock.
  //
  // It runs on the decoded request rather than in either entry point, so the
  // query and body transports cannot diverge on which scopes they accept.
  let scopeFilter: string | undefined;
  try {
    scopeFilter = parseScopeFilter(params.scope);
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  span.setAttributes({
    'lorekit.operation': 'memories.list',
    ...(scopeFilter ? { 'lorekit.scope': scopeFilter } : {}),
    ...(params.key ? { 'lorekit.key': params.key } : {}),
    'lorekit.limit': params.limit,
    'lorekit.archived': String(params.archived),
    'lorekit.sort': params.sort,
  });

  const { dimensions: d } = params;

  // A cursor minted under the other sort order is not comparable with this one,
  // so it is ignored (→ first page) rather than silently mis-paging. Unchanged
  // contract; only the place the two halves are applied has moved.
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  const usableCursor = cursor && cursor.sort === params.sort ? cursor : null;

  // The asymmetric `(after, on_or_before]` window stays in TypeScript so the
  // `now`-relative boundary has exactly one implementation (edge-parity.spec.ts
  // guards the copy). Absent → both bounds null → the filter is not applied.
  const expiring =
    params.expiring_within_days !== undefined
      ? expiringWindow(params.expiring_within_days, new Date().toISOString())
      : null;
  if (expiring) span.setAttributes({ 'lorekit.expiring_within_days': params.expiring_within_days ?? 0 });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<ListRpcRow>('lorekit_memory_list', {
    // Service-role callers act as the named user; an RLS-scoped JWT caller is
    // themselves whatever they pass. Same actor rule as the other two readers,
    // and the reason this needs no separate `applyRestTenantScope`: the
    // function's own visibility predicate IS the tenant boundary.
    p_user_id: auth.userId ?? null,
    p_archived: params.archived,
    p_scope: scopeFilter ?? null,
    p_key: params.key ?? null,
    // Already LIKE-escaped; the function appends the one active wildcard.
    p_key_prefix: likeNeedle(params.key_prefix),
    p_q: likeNeedle(params.q),
    p_created_since: params.created_since ?? null,
    p_created_until: params.created_until ?? null,
    p_expires_after: expiring?.after ?? null,
    p_expires_on_or_before: expiring?.onOrBefore ?? null,
    // Empty means "not filtered", and the function reads null for that — so an
    // untouched dimension is null rather than an empty array, which `= any('{}')`
    // would turn into "matches nothing".
    p_tags: d.tags.values.length ? d.tags.values : null,
    p_tags_mode: d.tags.mode,
    p_source_agent: d.source_agent.values.length ? d.source_agent.values : null,
    p_source_agent_mode: d.source_agent.mode,
    p_trigger: d.trigger.values.length ? d.trigger.values : null,
    p_trigger_mode: d.trigger.mode,
    p_kind: d.kind.values.length ? d.kind.values : null,
    p_kind_mode: d.kind.mode,
    p_host: d.host.values.length ? d.host.values : null,
    p_host_mode: d.host.mode,
    p_origin_repo: d.origin_repo.values.length ? d.origin_repo.values : null,
    p_origin_repo_mode: d.origin_repo.mode,
    p_origin_branch: d.origin_branch.values.length ? d.origin_branch.values : null,
    p_origin_branch_mode: d.origin_branch.mode,
    // Already digits-only from the shared decoder; the function coerces to
    // integer and drops anything that is not, so the two agree either way.
    p_origin_pr: d.origin_pr.values.length ? d.origin_pr.values : null,
    p_origin_pr_mode: d.origin_pr.mode,
    // Slugs, resolved against the caller's visible orgs INSIDE the function —
    // which is why the owner filter no longer needs a round-trip of its own.
    p_owner: d.owner.values.length ? d.owner.values : null,
    p_owner_mode: d.owner.mode,
    p_sort: params.sort,
    p_cursor_ts: usableCursor?.ts ?? null,
    p_cursor_id: usableCursor?.id ?? null,
    // limit + 1: the overflow row is what `buildPage` reads `hasMore` from.
    p_limit: params.limit + 1,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const page = buildPage((data ?? []) as ListRpcRow[], params.limit, params.sort);
  span.setAttributes({ 'lorekit.result_count': page.entries.length, 'lorekit.has_more': page.hasMore });
  // Let the router record the RECORD count (not just the call) — see
  // RESULT_COUNT_HEADER in _shared/api/router.ts.
  const res = ok({ ...page, entries: page.entries.map(shapeRpcRow) }, cors);
  res.headers.set('X-LoreKit-Result-Count', String(page.entries.length));
  return res;
}

/**
 * `GET /memories` — the query-string form.
 *
 * Fully supported and unchanged: the CLI, the MCP surface and every API-token
 * caller use it, and a link carrying a handful of filters is genuinely better
 * as a URL. It is simply not a transport that SCALES — each dimension is one
 * comma-joined string capped at 2048 characters, and the whole URL has an
 * unguarded ceiling of its own — so the dashboard, whose filter bar is
 * unbounded, uses `POST /memories/list` instead.
 */
export async function handleList(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListMemoriesQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const p = validated.data;

  return respondWithPage({
    scope: p.scope,
    key: p.key,
    key_prefix: p.key_prefix,
    q: p.q,
    created_since: p.created_since,
    created_until: p.created_until,
    sort: p.sort,
    archived: p.archived === 'true',
    expiring_within_days: p.expiring_within_days,
    limit: p.limit,
    cursor: p.cursor,
    dimensions: dimensionsFromQuery(p),
  }, auth, db, span, cors);
}

/**
 * `POST /memories/list` — the same read, over a JSON body.
 *
 * Exists because the Explorer's filter bar has nine dimensions whose value sets
 * are unbounded (agents invent hosts), and a query string is not a transport
 * that carries them: `ValueListSchema` rejects a dimension past 2048 characters
 * with a `400`, which the UI can only render as "Failed to load memories", and
 * even under that cap eight dimensions compose a URL past what the gateway
 * accepts — a failure that arrives with no LoreKit error envelope at all.
 * Raising the cap only moves the first wall and makes the second arrive first.
 *
 * `validateOptionalBody` so a bodiless `POST /memories/list` is the unfiltered
 * first page rather than a 400 — every field has a default, exactly the case
 * that helper exists for.
 */
export async function handleListPost(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = await validateOptionalBody(req, ListMemoriesBodySchema, cors);
  if (!validated.ok) return validated.response;
  const b = validated.data;

  return respondWithPage({
    scope: b.scope,
    key: b.key,
    key_prefix: b.key_prefix,
    q: b.q,
    created_since: b.created_since,
    created_until: b.created_until,
    sort: b.sort,
    archived: b.archived,
    expiring_within_days: b.expiring_within_days,
    limit: b.limit,
    cursor: b.cursor,
    dimensions: dimensionsFromBody(b),
  }, auth, db, span, cors);
}
