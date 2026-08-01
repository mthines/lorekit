import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { SearchMemoriesBodySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope } from '../../_shared/api/tenant.ts';
import { applyFilter } from '../../_shared/api/filter.ts';

type MemoryRow = Tables<'memories'>;

export async function handleSearch(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, SearchMemoriesBodySchema, cors);
  if (!v.ok) return v.response;
  const body = v.data;

  span.setAttributes({ 'lorekit.operation': 'memories.search', ...(body.q ? { 'lorekit.query': body.q } : {}), 'lorekit.filtered': body.filter !== undefined, 'lorekit.limit': body.limit });

  const tracedDb = createTracedClient(db, span);

  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .select(MEMORY_SELECT)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(body.limit + 1);

  // api_key auth uses service-role client (bypasses RLS) — apply tenant filter.
  // JWT auth uses RLS-scoped client — RLS handles visibility automatically.
  if (auth.type === 'api_key' && auth.userId) {
    const orgIds = await getMemberOrgIds(db, auth.userId, span);
    q = applyRestTenantScope(q, auth.userId, orgIds);
  }
  if (body.q) q = q.textSearch('fts', body.q, { type: 'websearch', config: 'english' });
  if (body.scopes?.length) q = q.in('scope', body.scopes);
  if (body.tags?.length) q = q.overlaps('tags', body.tags);
  // OR+AND structured filter tree — whitelisted fields only (see _shared/api/filter.ts)
  if (body.filter) q = applyFilter(q, body.filter);
  if (body.cursor) { const c = decodeCursor(body.cursor); if (c && c.sort === 'updated_at') q = q.or(`updated_at.lt.${c.ts},and(updated_at.eq.${c.ts},id.lt.${c.id})`); }

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const page = buildPage(data ?? [], body.limit);
  span.setAttributes({ 'lorekit.result_count': page.entries.length });
  // Record count for the router's usage event — see RESULT_COUNT_HEADER.
  const res = ok({ ...page, entries: page.entries.map(shapeMemoryRow) }, cors);
  res.headers.set('X-LoreKit-Result-Count', String(page.entries.length));
  return res;
}
