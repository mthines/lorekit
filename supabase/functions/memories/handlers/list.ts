import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, forbidden } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { ListMemoriesQuerySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import { parseTagsParam, pgArrayLiteral } from '../../_shared/schemas/tags.ts';
import { likeNeedle, ilikeClause, inListLiteral } from '../../_shared/schemas/filter.ts';
import { expiringWindow } from '../../_shared/expiring-window.ts';
import type { ScalarFilterMode } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope, firstDeniedScope } from '../../_shared/api/tenant.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';

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

export async function handleList(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListMemoriesQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  span.setAttributes({
    'lorekit.operation': 'memories.list',
    ...(params.scope ? { 'lorekit.scope': params.scope } : {}),
    ...(params.key ? { 'lorekit.key': params.key } : {}),
    'lorekit.limit': params.limit,
    'lorekit.archived': params.archived,
    'lorekit.sort': params.sort,
  });

  const tracedDb = createTracedClient(db, span);
  const isArchived = params.archived === 'true';
  const sort = params.sort;

  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .select(MEMORY_SELECT)
    .order(sort, { ascending: false })
    .order('id', { ascending: false })
    .limit(params.limit + 1);

  if (isArchived) q = q.not('archived_at', 'is', null);
  else q = q.is('archived_at', null).or('expires_at.is.null,expires_at.gt.now()');

  // Early refusal for a NAMED scope outside the key's allowlist (00067): a
  // plain 403 beats an empty page, which reads as "there is nothing there".
  const deniedScope = firstDeniedScope(auth, [params.scope]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

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

  const tags = parseTagsParam(params.tags);
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
    if (params.tags_mode === 'all') q = q.contains('tags', literal);
    else if (params.tags_mode === 'none') q = q.not('tags', 'ov', literal);
    else q = q.overlaps('tags', literal);
  }

  // Provenance / authorship dimensions. Each is its own conjunct (AND across
  // dimensions) holding a disjunction of values (OR within a dimension) — the
  // only combination a flat filter bar can render without a precedence
  // grammar. `parseTagsParam` is reused so every list-valued query param splits
  // by one rule.
  q = applyScalarFilter(q, 'source_agent', parseTagsParam(params.source_agent), params.source_agent_mode);
  q = applyScalarFilter(q, 'trigger', parseTagsParam(params.trigger), params.trigger_mode);
  // Taxonomy dimensions — `?kind=lesson&host=reviewer` reads "reviewer's
  // lessons". Same conjunct-of-disjunction shape as the provenance filters.
  q = applyScalarFilter(q, 'kind', parseTagsParam(params.kind), params.kind_mode);
  q = applyScalarFilter(q, 'host', parseTagsParam(params.host), params.host_mode);
  q = applyScalarFilter(q, 'origin_repo', parseTagsParam(params.origin_repo), params.origin_repo_mode);
  q = applyScalarFilter(q, 'origin_branch', parseTagsParam(params.origin_branch), params.origin_branch_mode);
  // `origin_pr` is an integer column. A non-numeric entry is dropped rather
  // than 400ing the request: the list arrives from a hand-editable URL, and one
  // bad entry should narrow the filter, not break the page. An entry list that
  // reduces to empty applies no filter at all, matching every other dimension.
  q = applyScalarFilter(
    q,
    'origin_pr',
    parseTagsParam(params.origin_pr).filter((v) => /^\d+$/.test(v)),
    params.origin_pr_mode,
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

  const ownerValues = parseTagsParam(params.owner);
  if (ownerValues.length > 0) {
    const wantsPersonal = ownerValues.includes('personal');
    // Resolve EVERY value as a slug — INCLUDING the literal `personal`, which an
    // org may legally use (00014 only lowercases the slug, it does not reserve
    // the word). 00064's SQL matches such a slug too (`o.slug = any(p_owner)`),
    // so resolving it here keeps the list, the facet counts and the stat header
    // in agreement; `wantsPersonal` ADDITIONALLY admits the personal (org_id
    // null) partition.
    const orgIds = await resolveOwnerOrgIds(db, memberOrgIds, ownerValues, span);
    q = applyOwnerFilter(q, params.owner_mode, wantsPersonal, orgIds);
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
    q = applyRestTenantScope(q, auth.userId, memberOrgIds ?? [], keyRestriction(auth));
  }

  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    // A cursor minted under the other sort order is not comparable with this
    // one, so it is ignored (→ first page) rather than silently mis-paging.
    if (c && c.sort === sort) {
      q = q.or(`${sort}.lt.${c.ts},and(${sort}.eq.${c.ts},id.lt.${c.id})`);
    }
  }

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const page = buildPage((data ?? []) as MemoryRow[], params.limit, sort);
  span.setAttributes({ 'lorekit.result_count': page.entries.length, 'lorekit.has_more': page.hasMore });
  // Let the router record the RECORD count (not just the call) — see
  // RESULT_COUNT_HEADER in _shared/api/router.ts.
  const res = ok({ ...page, entries: page.entries.map(shapeMemoryRow) }, cors);
  res.headers.set('X-LoreKit-Result-Count', String(page.entries.length));
  return res;
}
