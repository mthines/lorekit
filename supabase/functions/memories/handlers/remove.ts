import type { AuthContext } from '../../_shared/api/auth.ts';
import { noContent, notFound, badRequest } from '../../_shared/api/respond.ts';
import { validateUuid, validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { DeleteMemoryQuerySchema } from '@lorekit/schemas/memory';
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
 * No audit event is written here. Unlike the MCP path, the REST handlers have
 * no audit writer at all (no `_shared` equivalent of `mcp/audit.ts` exists, and
 * neither create.ts nor update.ts audits); adding a second, divergent audit
 * path from one handler would be worse than the current consistent gap.
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

  const { count, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  if (!count || count === 0) return notFound('Memory', cors);
  span.setAttributes({ 'lorekit.result.deleted': force, 'lorekit.result.archived': !force });
  return noContent(cors);
}
