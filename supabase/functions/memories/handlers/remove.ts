import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { noContent, notFound, badRequest } from '../../_shared/api/respond.ts';
import { validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

export async function handleRemove(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const url = new URL(req.url);
  const scopeParam = url.searchParams.get('scope');
  const keyParam = url.searchParams.get('key');
  const idParam = params.id;

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const now = new Date().toISOString();
  span.setAttributes({ 'lorekit.operation': 'memories.remove' });

  let q: TracedQuery<MemoryRow> = tracedDb.from<MemoryRow>('memories').update({ archived_at: now }, { count: 'exact' }).is('archived_at', null);

  if (idParam) {
    const v = validateUuid(idParam, cors);
    if (!v.ok) return v.response;
    span.setAttributes({ 'lorekit.memory_id': v.data });
    q = q.eq('id', v.data);
  } else if (scopeParam && keyParam) {
    span.setAttributes({ 'lorekit.scope': scopeParam, 'lorekit.key': keyParam });
    q = q.eq('scope', scopeParam).eq('key', keyParam);
  } else {
    return badRequest('Provide either an id path param or scope+key query params', undefined, cors);
  }

  if (auth.type !== 'service' && auth.userId) q = q.eq('user_id', auth.userId);

  const { count, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  if (!count || count === 0) return notFound('Memory', cors);
  return noContent(cors);
}
