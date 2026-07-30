import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, notFound } from '../../_shared/api/respond.ts';
import { validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope } from '../../_shared/api/tenant.ts';

type MemoryRow = Tables<'memories'>;

export async function handleGet(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = validateUuid(params.id ?? '', cors);
  if (!v.ok) return v.response;

  span.setAttributes({ 'lorekit.operation': 'memories.get', 'lorekit.memory_id': v.data });

  const tracedDb = createTracedClient(db, span);
  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .eq('id', v.data)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()');

  // api_key auth uses service-role client (bypasses RLS) — apply tenant filter.
  // JWT auth uses RLS-scoped client — RLS handles visibility automatically.
  if (auth.type === 'api_key' && auth.userId) {
    const orgIds = await getMemberOrgIds(db, auth.userId, span);
    q = applyRestTenantScope(q, auth.userId, orgIds);
  }

  const { data, error } = await q.maybeSingle();
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  if (!data) return notFound('Memory', cors);
  return ok(data, cors);
}
