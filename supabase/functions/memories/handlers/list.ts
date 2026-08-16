import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateOptionalBody, validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import type { SortColumn } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import {
  ListMemoriesBodySchema,
  ListMemoriesQuerySchema,
  MEMORY_SELECT,
  shapeMemoryRow,
} from '../../_shared/schemas/memory.ts';
import { dimensionsFromBody, dimensionsFromQuery } from '../../_shared/schemas/dimensions.ts';
import type { MemoryDimensions } from '../../_shared/schemas/dimensions.ts';
import { pgArrayLiteral } from '../../_shared/schemas/tags.ts';
import { likeNeedle, ilikeClause, inListLiteral } from '../../_shared/schemas/filter.ts';
import { expiringWindow } from '../../_shared/expiring-window.ts';
import type { ScalarFilterMode } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope } from '../../_shared/api/tenant.ts';

type MemoryRow = Tables<'memories'>;

/**
 * Apply one scalar multi-value filter (`source_agent`, `trigger`, `origin_*`).
 *
 * `in` is the disjunction, `nin` its negation. The negation is expressed as
 * PostgREST's `not.in` rather than a chain of `neq`s because the two agree only
 * while the column is NOT NULL and every column here is nullable — keeping the
 * negation inside one operator means the SQL cannot drift from what the filter
 * pill claims.
 *
 * Both directions go through `.or()` with a single clause rather than
 * `.in()` / `.not()`, so ONE encoding covers them: `inListLiteral` quotes each
 * value with the same `quoteFilterValue` the `q` substring filter and the
 * `POST /memories/search` filter tree already use, and `.or()` appends the
 * expression verbatim through `URLSearchParams`. These columns are free text
 * written by agents, so a value containing a `.`, a `()` or a double quote is
 * reachable — each would otherwise terminate the `in.()` operand or break the
 * quoting — and postgrest-js's own `.in()` quoting does not escape an embedded
 * double quote. A COMMA is the one reserved character that cannot arrive here:
 * every caller below splits the param with `parseTagsParam` first, so a
 * comma-bearing value is delivered as two values, never one. Repeated `or=`
 * params are ANDed by PostgREST, so each call is its own conjunct — which is
 * exactly the "AND across dimensions" rule.
 */
function applyScalarFilter(
  q: TracedQuery<MemoryRow>,
  column: string,
  values: readonly string[],
  mode: ScalarFilterMode,
  // `origin_pr` is an `integer` column and its values are digits-only by the
  // time they reach here, so they are emitted bare — PostgREST parses a quoted
  // operand as text and the cast to integer is a needless place to be wrong.
  { quote = true }: { quote?: boolean } = {},
): TracedQuery<MemoryRow> {
  if (values.length === 0) return q;
  const operator = mode === 'nin' ? 'not.in' : 'in';
  const operand = quote ? inListLiteral(values) : `(${values.join(',')})`;
  return q.or(`${column}.${operator}.${operand}`);
}

/**
 * Resolve owner-filter SLUGS to the org ids the caller can actually see.
 *
 * JWT callers run on an RLS-scoped client, so a plain `orgs` select already
 * hides orgs they are not in. The api_key tier is service-role (no RLS), so the
 * result is restricted to the caller's member org ids explicitly — the same
 * fail-closed treatment `applyRestTenantScope` gives the memories read. A slug
 * that does not resolve to a visible org contributes no id, so the filter
 * narrows to nothing rather than widening past the tenant boundary.
 */
async function resolveOwnerOrgIds(
  db: DbClient,
  memberOrgIds: readonly string[] | null,
  slugs: readonly string[],
  span: Span,
): Promise<string[]> {
  const tracedDb = createTracedClient(db, span);
  let q = tracedDb.from<{ id: string; slug: string }>('orgs').select('id,slug').in('slug', slugs as string[]);
  // api_key is service-role (no RLS), so restrict to the caller's member orgs —
  // resolved ONCE by the handler and passed in (the tenant-scope step below reuses
  // the same list). JWT auth is RLS-scoped, so a plain `orgs` select already hides
  // non-member orgs and `memberOrgIds` is null (no restriction needed).
  if (memberOrgIds !== null) {
    if (memberOrgIds.length === 0) return [];
    q = q.in('id', memberOrgIds as string[]);
  }
  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/**
 * Apply the owner predicate at the PostgREST level, mirroring the SQL in
 * `lorekit_memory_facets` / `lorekit_memory_activity` (00064).
 *
 * `in`  → keep a row whose owner identity is one of the selected values:
 *         personal rows (`org_id is null`) when `personal` was picked, OR rows in
 *         a selected org. When nothing selected resolves to a visible owner the
 *         page is empty — the honest answer to `owner=in[<unknown slug>]`.
 * `nin` → keep a row whose identity is NONE of them: drop personal rows when
 *         `personal` was picked, and drop rows in a selected org. A `nin` over
 *         only unresolvable slugs excludes nothing, which is a no-op.
 */
function applyOwnerFilter(
  q: TracedQuery<MemoryRow>,
  mode: ScalarFilterMode,
  wantsPersonal: boolean,
  orgIds: readonly string[],
): TracedQuery<MemoryRow> {
  // Route the id list through the SAME `inListLiteral` (→ `quoteFilterValue`)
  // encoding every other `in.()` operand in this file uses, per the memories
  // edge's single-encoding rule. Uuids carry no reserved character today, so
  // this is consistency, not a live fix — but hand-joining is exactly how a
  // future non-uuid identifier would slip past the quoting.
  const inList = orgIds.length > 0 ? inListLiteral(orgIds) : null;
  if (mode === 'nin') {
    if (wantsPersonal) {
      // Drop the personal partition; also drop rows in any named org.
      q = q.not('org_id', 'is', null);
      if (inList) q = q.or(`org_id.not.in.${inList}`);
    } else if (inList) {
      // Keep personal rows and org rows outside the named set. `org_id.not.in`
      // is NULL for a personal row, so it is ORed with the explicit null test.
      q = q.or(`org_id.is.null,org_id.not.in.${inList}`);
    }
    return q;
  }
  const disjuncts: string[] = [];
  if (wantsPersonal) disjuncts.push('org_id.is.null');
  if (inList) disjuncts.push(`org_id.in.${inList}`);
  if (disjuncts.length === 0) {
    // `id` is a NOT NULL primary key, so this is a total contradiction — no row.
    return q.is('id', null);
  }
  return q.or(disjuncts.join(','));
}


/**
 * The list read, decoded from EITHER transport.
 *
 * `GET /memories` and `POST /memories/list` differ only in how a request is
 * spelled — a query string, where every value is a string and every dimension
 * is comma-joined, or a JSON body, where they are real types and real arrays.
 * Both decode into this shape, and everything below applies predicates from
 * THIS and nothing else, so the two routes cannot answer differently. That is
 * the point: the body route exists because a URL cannot carry an unbounded
 * filter bar, not because the read should behave differently.
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
 * Build the fully-predicated query for a decoded list request.
 *
 * Everything that turns a filter into SQL lives here, once. A dimension added
 * to one transport and forgotten on the other is not possible: neither handler
 * touches PostgREST at all.
 */
async function buildListQuery(
  params: ListParams,
  auth: AuthContext,
  db: DbClient,
  span: Span,
): Promise<TracedQuery<MemoryRow>> {
  const tracedDb = createTracedClient(db, span);
  const { sort, dimensions } = params;

  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .select(MEMORY_SELECT)
    .order(sort, { ascending: false })
    .order('id', { ascending: false })
    .limit(params.limit + 1);

  if (params.archived) q = q.not('archived_at', 'is', null);
  else q = q.is('archived_at', null).or('expires_at.is.null,expires_at.gt.now()');

  if (params.scope) q = q.eq('scope', params.scope);
  if (params.key) q = q.eq('key', params.key);

  // `key_prefix` is a case-insensitive PREFIX match, distinct from the exact
  // `key` above. `likeNeedle` escapes the LIKE metacharacters (so a `%`/`_` the
  // user typed is data, not a wildcard); `ilikeClause` with `prefix:false`
  // yields `key.ilike."<prefix>%"` — the trailing `%` is the only active
  // wildcard — and quotes the value the one way the PostgREST logic-tree
  // grammar carries a reserved character, exactly as the `q` filter below does.
  const keyPrefixNeedle = likeNeedle(params.key_prefix);
  if (keyPrefixNeedle) q = q.or(ilikeClause('key', keyPrefixNeedle, { prefix: false }));

  const tags = dimensions.tags.values;
  if (tags.length) {
    // A STRING array literal, never a string[] — postgrest-js joins an array
    // with a bare `,`, which mis-parses a label containing a comma/brace/quote
    // into several labels (`@lorekit/schemas/tags`).
    const literal = pgArrayLiteral(tags);
    // `all` is containment (@>) — every named label must be present. `any` is
    // overlap (&&) and stays the default, so existing callers are unchanged.
    // `none` is the negation of `any`, so it MUST be `not.ov` and not
    // `not.cs`: "carries none of these" is NOT(carries any), while NOT(carries
    // all) would also admit a row carrying all but one of them.
    if (dimensions.tags.mode === 'all') q = q.contains('tags', literal);
    else if (dimensions.tags.mode === 'none') q = q.not('tags', 'ov', literal);
    else q = q.overlaps('tags', literal);
  }

  // Provenance / authorship dimensions. Each is its own conjunct (AND across
  // dimensions) holding a disjunction of values (OR within a dimension) — the
  // only combination a flat filter bar can render without a precedence
  // grammar. The values arrive already split, trimmed and de-duped by the ONE
  // shared decoder, so "a comma cannot reach this code as part of a value" is
  // a property of the query WIRE FORMAT rather than something applied here —
  // which is exactly why the body form can carry one.
  q = applyScalarFilter(q, 'source_agent', dimensions.source_agent.values, dimensions.source_agent.mode);
  q = applyScalarFilter(q, 'trigger', dimensions.trigger.values, dimensions.trigger.mode);
  // Taxonomy dimensions — `kind=lesson` + `host=reviewer` reads "reviewer's
  // lessons". Same conjunct-of-disjunction shape as the provenance filters.
  q = applyScalarFilter(q, 'kind', dimensions.kind.values, dimensions.kind.mode);
  q = applyScalarFilter(q, 'host', dimensions.host.values, dimensions.host.mode);
  q = applyScalarFilter(q, 'origin_repo', dimensions.origin_repo.values, dimensions.origin_repo.mode);
  q = applyScalarFilter(q, 'origin_branch', dimensions.origin_branch.values, dimensions.origin_branch.mode);
  // `origin_pr` is an integer column; the decoder has already dropped any
  // non-numeric entry (one bad entry narrows the filter rather than 400ing a
  // page built from a hand-editable URL), so the values are emitted bare.
  q = applyScalarFilter(
    q,
    'origin_pr',
    dimensions.origin_pr.values,
    dimensions.origin_pr.mode,
    { quote: false },
  );

  // Owner (00064) — the ownership dimension, `personal` (org_id is null) plus
  // org SLUGS. This was the ONE filter the dashboard narrowed CLIENT-side; it is
  // server-side now, so the list, the facet counts and the stat header agree.
  // It cannot go through `applyScalarFilter` because `personal` and a slug map to
  // DIFFERENT columns (`org_id is null` vs `org_id in (<resolved ids>)`) — the
  // slugs are resolved to the org ids the caller can see, so an unknown or
  // non-member slug narrows to nothing rather than widening.
  // api_key auth is service-role (bypasses RLS), so tenant visibility is applied
  // explicitly (below) AND owner-slug resolution must restrict to member orgs.
  // Resolve the member org ids ONCE here so an owner-filtered api_key request pays
  // ONE round-trip, not two. JWT auth is RLS-scoped and needs neither → null.
  const memberOrgIds =
    auth.type === 'api_key' && auth.userId ? await getMemberOrgIds(db, auth.userId, span) : null;

  const ownerValues = dimensions.owner.values;
  if (ownerValues.length > 0) {
    const wantsPersonal = ownerValues.includes('personal');
    // Resolve EVERY value as a slug — INCLUDING the literal `personal`, which an
    // org may legally use (00014 only lowercases the slug, it does not reserve
    // the word). 00064's SQL matches such a slug too (`o.slug = any(p_owner)`),
    // so resolving it here keeps the list, the facet counts and the stat header
    // in agreement; `wantsPersonal` ADDITIONALLY admits the personal (org_id
    // null) partition.
    const orgIds = await resolveOwnerOrgIds(db, memberOrgIds, ownerValues, span);
    q = applyOwnerFilter(q, dimensions.owner.mode, wantsPersonal, orgIds);
  }

  // Substring filter over key OR value. `likeNeedle` escapes the LIKE
  // metacharacters (so a `%` the user typed is data, not a wildcard) and
  // `ilikeClause` double-quotes the finished pattern, which is how PostgREST's
  // URL grammar carries a reserved character (`,` `.` `:` `()`) inside a logic
  // tree — the SAME composition `serializeFilterGroup` uses for a `contains`
  // condition, so the two search paths cannot encode differently.
  const needle = likeNeedle(params.q);
  if (needle) q = q.or(`${ilikeClause('key', needle)},${ilikeClause('value', needle)}`);

  // Half-open [created_since, created_until) window. Both bounds are validated
  // as an ISO date/timestamp by the schema before reaching PostgREST.
  if (params.created_since) q = q.gte('created_at', params.created_since);
  if (params.created_until) q = q.lt('created_at', params.created_until);

  // "Expiring soon" — `expires_at` in `(now, now + N days]`. The asymmetric
  // boundary lives in the shared `expiringWindow`, not here, so the tested copy
  // and the deployed one cannot drift (edge-parity.spec.ts).
  //
  // TWO predicates, not three: a memory with no TTL needs no `is not null`
  // clause because `null > x` and `null <= x` are both SQL NULL, so it fails
  // the comparison and drops out on its own. Both are plain conjuncts, so this
  // ANDs with the live branch above rather than widening it — and it re-states
  // the `> now` bound instead of leaning on that branch, so `archived=true`
  // (which has no liveness guard) still cannot surface an already-expired row.
  //
  // Range-scans `memories_expires_at_idx` (00030), the partial index on
  // `expires_at is not null` — which is precisely the row set these two
  // comparisons select, so no new index is needed.
  if (params.expiring_within_days !== undefined) {
    const window = expiringWindow(params.expiring_within_days, new Date().toISOString());
    q = q.gt('expires_at', window.after).lte('expires_at', window.onOrBefore);
    span.setAttributes({ 'lorekit.expiring_within_days': params.expiring_within_days });
  }

  // api_key auth uses service-role client (bypasses RLS) — apply tenant filter,
  // reusing the member org ids resolved once above. JWT auth uses an RLS-scoped
  // client — RLS handles visibility automatically (memberOrgIds stays null).
  if (auth.type === 'api_key' && auth.userId) {
    q = applyRestTenantScope(q, auth.userId, memberOrgIds ?? []);
  }

  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    // A cursor minted under the other sort order is not comparable with this
    // one, so it is ignored (→ first page) rather than silently mis-paging.
    if (c && c.sort === sort) {
      q = q.or(`${sort}.lt.${c.ts},and(${sort}.eq.${c.ts},id.lt.${c.id})`);
    }
  }

  return q;
}

/** Run a decoded list request and shape the keyset page. Shared by both routes. */
async function respondWithPage(
  params: ListParams,
  auth: AuthContext,
  db: DbClient,
  span: Span,
  cors: Record<string, string>,
): Promise<Response> {
  span.setAttributes({
    'lorekit.operation': 'memories.list',
    ...(params.scope ? { 'lorekit.scope': params.scope } : {}),
    ...(params.key ? { 'lorekit.key': params.key } : {}),
    'lorekit.limit': params.limit,
    'lorekit.archived': String(params.archived),
    'lorekit.sort': params.sort,
  });

  const q = await buildListQuery(params, auth, db, span);
  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const page = buildPage((data ?? []) as MemoryRow[], params.limit, params.sort);
  span.setAttributes({ 'lorekit.result_count': page.entries.length, 'lorekit.has_more': page.hasMore });
  // Let the router record the RECORD count (not just the call) — see
  // RESULT_COUNT_HEADER in _shared/api/router.ts.
  const res = ok({ ...page, entries: page.entries.map(shapeMemoryRow) }, cors);
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
