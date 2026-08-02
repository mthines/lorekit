import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { ListMemoriesQuerySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import { parseTagsParam, pgArrayLiteral } from '../../_shared/schemas/tags.ts';
import { likeNeedle, ilikeClause } from '../../_shared/schemas/filter.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope } from '../../_shared/api/tenant.ts';

type MemoryRow = Tables<'memories'>;

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
    q = params.tags_mode === 'all' ? q.contains('tags', literal) : q.overlaps('tags', literal);
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
