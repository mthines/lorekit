import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit.ts';
import { noContent, notFound, badRequest } from '../../_shared/api/respond.ts';
import { validateUuid, validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { DeleteMemoryQuerySchema } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

/**
 * DELETE /memories/:id and DELETE /memories?scope=…&key=…
 *
 * Soft-archives by default (stamps `archived_at`). `?force=true` performs a
 * real row delete instead, mirroring the MCP `memory.delete` tool's force
 * branch (supabase/functions/mcp/tools.ts, toolDelete) — including its
 * `lorekit.delete.force` span attribute, so the two surfaces are queryable
 * together in traces.
 *
 * Audits through the one shared edge writer (`_shared/audit.ts`, the same
 * module `mcp/tools.ts` uses): `memory.delete` on the force branch,
 * `memory.archive` on the soft branch — matching toolDelete's actions,
 * `resourceType`, `target` and `metadata` so the two surfaces produce
 * comparable rows. Only after the mutation matched a row, and never able to
 * fail the request (recordAudit does not throw).
 */
export async function handleRemove(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, DeleteMemoryQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const { scope: scopeParam, key: keyParam, force: forceParam } = validated.data;
  const force = forceParam === 'true';
  const idParam = params.id;

  const tracedDb = createTracedClient(db, span);
  const now = new Date().toISOString();
  span.setAttributes({ 'lorekit.operation': 'memories.remove', 'lorekit.delete.force': force });

  // Hard delete removes the row outright, so it must NOT be constrained to
  // non-archived rows the way the soft-archive is — purging an already-archived
  // memory is the main reason a caller asks for force.
  let q: TracedQuery<MemoryRow> = force
    ? tracedDb.from<MemoryRow>('memories').delete({ count: 'exact' })
    : tracedDb.from<MemoryRow>('memories').update({ archived_at: now }, { count: 'exact' }).is('archived_at', null);

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

  // api_key auth uses service-role client — restrict to caller's own rows.
  // JWT auth uses RLS-scoped client — RLS handles access control.
  if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId);

  // `.select()` on the mutation returns the affected rows, which is the only
  // way the `/:id` form can name the scope+key the audit row needs — the MCP
  // tool always has them from its arguments. It also gives an exact
  // changed-row signal without depending on `count` alone.
  const { data, count, error } = await q.select('id,scope,key');
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const affected = (data ?? []) as unknown as Array<{ id: string; scope: string; key: string }>;
  if (!count || count === 0) return notFound('Memory', cors);
  span.setAttributes({ 'lorekit.result.deleted': force, 'lorekit.result.archived': !force });

  const actor = auditUserId(auth);
  for (const row of affected) {
    await recordAudit(
      db,
      {
        // No `resourceId`: toolDelete omits it (a hard-deleted row's id points
        // at nothing), and these rows must stay shape-comparable with the MCP
        // surface's.
        action: force ? 'memory.delete' : 'memory.archive',
        resourceType: 'memory',
        target: row.key,
        metadata: { scope: row.scope, key: row.key, force },
      },
      actor,
    );
  }
  return noContent(cors);
}
