import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { created } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { CreateMemoryBodySchema } from '@lorekit/schemas/memory';
import { translateDbError } from '../../_shared/api/errors.ts';
import type { DbClient } from '../../_shared/api/auth.ts';

export async function handleCreate(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, CreateMemoryBodySchema, cors);
  if (!v.ok) return v.response;
  const body = v.data;

  span.setAttributes({ 'lorekit.operation': 'memories.create', 'lorekit.scope': body.scope, 'lorekit.key': body.key });

  if (auth.userId) {
    const rlSpan = span.child('lorekit.rest.rate_limit');
    const tracedRl = createTracedClient(db as ReturnType<typeof createClient>, rlSpan);
    const { data: rlData } = await tracedRl.rpc('lorekit_check_rate_limit', { p_user_id: auth.userId, p_window_seconds: 60 });
    const row = Array.isArray(rlData) ? rlData[0] : rlData;
    rlSpan.setAttributes({ 'rate_limit.allowed': !!row?.allowed, 'rate_limit.current': row?.current_count ?? 0 }).end();
    if (row && !row.allowed) {
      const { tooManyRequests } = await import('../../_shared/api/respond.ts');
      return tooManyRequests(row.retry_after_seconds ?? 60, cors);
    }
  }

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb
    .from('memories')
    .upsert({
      scope: body.scope, key: body.key, value: body.value,
      tags: body.tags ?? [], source_agent: body.source_agent ?? null,
      trigger: body.trigger ?? null, org_id: null,
      ...(auth.type !== 'service' ? { user_id: auth.userId ?? null } : {}),
    }, { onConflict: 'scope,key' })
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .single();

  if (error) {
    const mapped = translateDbError(error);
    if (mapped) return mapped.toResponse(cors);
    span.error(`DB: ${error.message}`);
    throw error;
  }

  span.setAttributes({ 'lorekit.memory_id': data.id });
  return created(data, cors);
}
