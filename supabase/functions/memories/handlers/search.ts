import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { SearchMemoriesBodySchema } from '@lorekit/schemas/memory';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

export async function handleSearch(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, SearchMemoriesBodySchema, cors);
  if (!v.ok) return v.response;
  const body = v.data;

  span.setAttributes({ 'lorekit.operation': 'memories.search', ...(body.q ? { 'lorekit.query': body.q } : {}), 'lorekit.limit': body.limit });

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);

  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(body.limit + 1);

  if (auth.type !== 'service' && auth.userId) q = q.eq('user_id', auth.userId);
  if (body.q) q = q.textSearch('fts', body.q, { type: 'websearch', config: 'english' });
  if (body.scopes?.length) q = q.in('scope', body.scopes);
  if (body.tags?.length) q = q.overlaps('tags', body.tags);
  if (body.cursor) { const c = decodeCursor(body.cursor); if (c) q = q.or(`updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`); }

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const page = buildPage(data ?? [], body.limit);
  span.setAttributes({ 'lorekit.result_count': page.entries.length });
  return ok(page, cors);
}
