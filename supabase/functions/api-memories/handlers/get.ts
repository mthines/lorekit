import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, notFound } from '../../_shared/api/respond.ts';
import { validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';

export async function handleGet(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = validateUuid(params.id ?? '', cors);
  if (!v.ok) return v.response;

  span.setAttributes({ 'lorekit.operation': 'memories.get', 'lorekit.memory_id': v.data });

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  // deno-lint-ignore no-explicit-any
  let query: any = tracedDb
    .from('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .eq('id', v.data)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()');

  if (auth.type !== 'service' && auth.userId) query = query.eq('user_id', auth.userId);

  const { data, error } = await query.maybeSingle();
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  if (!data) return notFound('Memory', cors);
  return ok(data, cors);
}
