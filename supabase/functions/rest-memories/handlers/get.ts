/**
 * GET /rest-memories/:id
 *
 * Returns a single memory by UUID. Returns 404 if not found, archived, or expired.
 * Tenant scoping is applied — callers can only access their own memories or
 * memories belonging to orgs they are members of.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthContext, getUserId } from '../../_shared/api/auth.ts';
import { ok, notFound, fromError } from '../../_shared/api/respond.ts';
import { validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient, type Span } from '../../_shared/otel.ts';
import { applyTenantScope } from '../../_shared/tenant-scope.ts';

async function memberOrgIds(db: ReturnType<typeof createClient>, userId: string): Promise<string[]> {
  const { data, error } = await db.rpc('lorekit_member_org_ids', { p_user_id: userId });
  return error ? [] : ((data ?? []) as string[]);
}

export async function handleGet(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  params: Record<string, string>,
): Promise<Response> {
  const idResult = validateUuid(params['id'], 'id');
  if (!idResult.ok) return idResult.error;
  const id = idResult.data;

  span.setAttributes({ 'lorekit.rest.action': 'get', 'lorekit.memory.id': id });

  try {
    const userId = getUserId(auth);
    const tracedDb = createTracedClient(db, span);

    const SELECT =
      'id,scope,key,value,tags,source_agent,trigger,org_id,created_at,updated_at,expires_at,archived_at';

    let query = tracedDb
      .from('memories')
      .select(SELECT)
      .eq('id', id)
      .is('archived_at', null)
      .or('expires_at.is.null,expires_at.gt.now()');

    if (userId) {
      const orgIds = await memberOrgIds(db, userId);
      query = applyTenantScope(query, userId, orgIds);
    }

    const { data, error } = await (query as ReturnType<typeof query.maybeSingle>).maybeSingle();
    if (error) {
      span.error(`GetError: ${error.message}`);
      return fromError(error, 'get');
    }
    if (!data) return notFound('Memory not found');

    span.setAttributes({ 'lorekit.result.found': true });
    return ok(data);
  } catch (err) {
    return fromError(err, 'get');
  }
}
