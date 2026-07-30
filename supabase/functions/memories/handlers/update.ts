import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, notFound } from '../../_shared/api/respond.ts';
import { validateUuid, validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { UpdateMemoryBodySchema } from '@lorekit/schemas/memory';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

export async function handleUpdate(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const idV = validateUuid(params.id ?? '', cors);
  if (!idV.ok) return idV.response;
  const bodyV = await validateBody(req, UpdateMemoryBodySchema, cors);
  if (!bodyV.ok) return bodyV.response;

  span.setAttributes({ 'lorekit.operation': 'memories.update', 'lorekit.memory_id': idV.data });

  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bodyV.data)) { if (v !== undefined) patch[k] = v; }

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  let q: TracedQuery<MemoryRow> = tracedDb.from<MemoryRow>('memories').update(patch).eq('id', idV.data).is('archived_at', null);
  if (auth.type !== 'service' && auth.userId) q = q.eq('user_id', auth.userId);

  const { data, error } = await q
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .maybeSingle();

  if (error) { span.error(`DB: ${error.message}`); throw error; }
  if (!data) return notFound('Memory', cors);
  return ok(data, cors);
}
