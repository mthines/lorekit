/**
 * PATCH /rest-memories/:id
 *
 * Partial update — only supplied fields are changed.
 * scope and key are immutable (use DELETE + POST to move a memory).
 *
 * Request body: MemoryUpdateSchema (all fields optional)
 * Response: the updated memory row
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthContext, getUserId } from '../../_shared/api/auth.ts';
import { ok, notFound, badRequest, fromError } from '../../_shared/api/respond.ts';
import { validateBody, validateUuid } from '../../_shared/api/validate.ts';
import { MemoryUpdateSchema } from '../../_shared/schemas/memory.ts';
import { createTracedClient, type Span } from '../../_shared/otel.ts';
import { applyTenantScope } from '../../_shared/tenant-scope.ts';

async function memberOrgIds(db: ReturnType<typeof createClient>, userId: string): Promise<string[]> {
  const { data, error } = await db.rpc('lorekit_member_org_ids', { p_user_id: userId });
  return error ? [] : ((data ?? []) as string[]);
}

export async function handleUpdate(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  params: Record<string, string>,
): Promise<Response> {
  const idResult = validateUuid(params['id'], 'id');
  if (!idResult.ok) return idResult.error;
  const id = idResult.data;

  const parsed = await validateBody(req, MemoryUpdateSchema);
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;

  // At least one field must be provided
  const hasUpdate = Object.values(input).some((v) => v !== undefined);
  if (!hasUpdate) {
    return badRequest('At least one field must be provided for update');
  }

  span.setAttributes({ 'lorekit.rest.action': 'update', 'lorekit.memory.id': id });

  try {
    const userId = getUserId(auth);
    const tracedDb = createTracedClient(db, span);

    // First, verify the memory exists and belongs to the caller's tenant
    const SELECT =
      'id,scope,key,value,tags,source_agent,trigger,org_id,created_at,updated_at,expires_at,archived_at';

    let findQuery = tracedDb
      .from('memories')
      .select(SELECT)
      .eq('id', id)
      .is('archived_at', null);

    if (userId) {
      const orgIds = await memberOrgIds(db, userId);
      findQuery = applyTenantScope(findQuery, userId, orgIds);
    }

    const { data: existing, error: findError } = await (findQuery as ReturnType<typeof findQuery.maybeSingle>).maybeSingle();
    if (findError) return fromError(findError, 'update-find');
    if (!existing) return notFound('Memory not found');

    // Build the update payload — only include fields that were provided
    const updatePayload: Record<string, unknown> = {};
    if (input.value !== undefined) updatePayload['value'] = input.value;
    if (input.tags !== undefined) updatePayload['tags'] = input.tags;
    if (input.source_agent !== undefined) updatePayload['source_agent'] = input.source_agent;
    if (input.trigger !== undefined) updatePayload['trigger'] = input.trigger;

    // Handle TTL updates
    if (input.clear_ttl) {
      updatePayload['expires_at'] = null;
    } else if (input.ttl_days !== undefined) {
      const expiresAt = new Date(Date.now() + input.ttl_days * 24 * 60 * 60 * 1000);
      updatePayload['expires_at'] = expiresAt.toISOString();
    }

    const { data: updated, error: updateError } = await tracedDb
      .from('memories')
      .update(updatePayload)
      .eq('id', id)
      .select(SELECT)
      .single();

    if (updateError) return fromError(updateError, 'update');

    span.setAttributes({ 'lorekit.result.updated': true });
    return ok(updated);
  } catch (err) {
    return fromError(err, 'update');
  }
}
