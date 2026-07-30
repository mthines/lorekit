import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, notFound } from '../../_shared/api/respond.ts';
import { validateUuid, validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { UpdateMemoryBodySchema } from '@lorekit/schemas/memory';
import { recordRestAudit } from '../../_shared/audit.ts';
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

  const tracedDb = createTracedClient(db, span);
  let q: TracedQuery<MemoryRow> = tracedDb.from<MemoryRow>('memories').update(patch).eq('id', idV.data).is('archived_at', null);
  // api_key auth uses service-role client — restrict to caller's own rows.
  // JWT auth uses RLS-scoped client — RLS handles access control (org-owned rows included).
  if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId);

  const { data, error } = await q
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .maybeSingle();

  if (error) { span.error(`DB: ${error.message}`); throw error; }
  // Audit only on the success path — never for the 404 below, where no row
  // matched and therefore nothing was updated.
  if (!data) return notFound('Memory', cors);

  const updated = data as Pick<MemoryRow, 'id' | 'scope' | 'key'>;
  await recordRestAudit(db, span, auth, {
    action: 'memory.update',
    resourceType: 'memory',
    resourceId: updated.id,
    target: updated.key,
    metadata: { scope: updated.scope, key: updated.key },
  });

  return ok(data, cors);
}
