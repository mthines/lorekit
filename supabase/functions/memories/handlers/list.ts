import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { ListMemoriesQuerySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import { parseTagsParam, pgArrayLiteral } from '../../_shared/schemas/tags.ts';
import { likeNeedle, ilikeClause, inListLiteral } from '../../_shared/schemas/filter.ts';
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
 * written by agents, so a value containing a comma or a parenthesis is
 * reachable, and postgrest-js's own `.in()` quoting does not escape an embedded
 * double quote. Repeated `or=` params are ANDed by PostgREST, so each call is
 * its own conjunct — which is exactly the "AND across dimensions" rule.
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

  if (params.scope) q = q.eq('scope', params.scope);
  if (params.key) q = q.eq('key', params.key);

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

  // api_key auth uses service-role client (bypasses RLS) — apply tenant filter.
  // JWT auth uses RLS-scoped client — RLS handles visibility automatically.
  if (auth.type === 'api_key' && auth.userId) {
    const orgIds = await getMemberOrgIds(db, auth.userId, span);
    q = applyRestTenantScope(q, auth.userId, orgIds);
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
