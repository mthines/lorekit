/**
 * DELETE /rest-memories/:id
 *
 * Soft-archives a memory by setting archived_at.
 * The memory is hidden from normal reads but can be restored via the MCP
 * memory.restore tool or listed via memory.list_archived.
 *
 * Query params:
 *   force=true — permanently hard-delete the row (unrecoverable)
 *
 * Response: 204 No Content on success
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthContext, getUserId } from '../../_shared/api/auth.ts';
import { noContent, notFound, fromError } from '../../_shared/api/respond.ts';
import { validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient, type Span } from '../../_shared/otel.ts';
import { applyTenantScope } from '../../_shared/tenant-scope.ts';

async function memberOrgIds(db: ReturnType<typeof createClient>, userId: string): Promise<string[]> {
  const { data, error } = await db.rpc('lorekit_member_org_ids', { p_user_id: userId });
  return error ? [] : ((data ?? []) as string[]);
}

export async function handleRemove(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  params: Record<string, string>,
): Promise<Response> {
  const idResult = validateUuid(params['id'], 'id');
  if (!idResult.ok) return idResult.error;
  const id = idResult.data;

  const force = new URL(req.url).searchParams.get('force') === 'true';

  span.setAttributes({
    'lorekit.rest.action': 'remove',
    'lorekit.memory.id': id,
    'lorekit.delete.force': force,
  });

  try {
    const userId = getUserId(auth);
    const tracedDb = createTracedClient(db, span);

    if (force) {
      // Hard delete — immediate and unrecoverable
      let query = tracedDb.from('memories').delete({ count: 'exact' }).eq('id', id);
      // For api_key, additionally scope to tenant to prevent cross-tenant hard-delete
      if (userId) {
        const orgIds = await memberOrgIds(db, userId);
        // Hard-delete only personal rows via api_key — org rows must go through org RPC
        query = query.eq('user_id', userId) as typeof query;
        void orgIds; // org-owned hard-deletes not supported via REST for now
      }
      const { error, count } = await query;
      if (error) return fromError(error, 'remove-force');
      if ((count ?? 0) === 0) return notFound('Memory not found');

      span.setAttributes({ 'lorekit.result.deleted': true });
      return noContent();
    }

    // Soft-archive — set archived_at
    let query = tracedDb
      .from('memories')
      .update({ archived_at: new Date().toISOString() }, { count: 'exact' })
      .eq('id', id)
      .is('archived_at', null); // only archive active rows

    if (userId) {
      const orgIds = await memberOrgIds(db, userId);
      query = applyTenantScope(query, userId, orgIds);
    }

    const { error, count } = await query;
    if (error) return fromError(error, 'remove');
    if ((count ?? 0) === 0) return notFound('Memory not found or already archived');

    span.setAttributes({ 'lorekit.result.archived': true });
    return noContent();
  } catch (err) {
    return fromError(err, 'remove');
  }
}
