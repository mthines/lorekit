import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, notFound } from '../../_shared/api/respond.ts';
import { validateBody, validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { RestoreMemoryBodySchema } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

/**
 * POST /memories/:id/restore and POST /memories/restore
 *
 * Un-archives a previously soft-deleted memory. Mirrors the MCP `memory.restore`
 * tool (supabase/functions/mcp/tools.ts, toolRestore): `update({ archived_at: null })`
 * guarded by `.not('archived_at','is',null)` so restoring a live row is a no-op
 * match (0 rows) rather than a silent success — that guard is what makes the
 * 404 below meaningful.
 *
 * Response shape is `200 { restored: true }`, matching the MCP tool's return
 * value rather than a bare 204. Two reasons: the CLI reads `{ restored }` off
 * the MCP result today, so keeping the body identical is what lets it swap
 * transports without touching its call sites; and 204 would make "restored" and
 * "there was nothing to restore" indistinguishable without inspecting the status
 * code, whereas a body leaves room for the field to become informative later.
 * `restored` is always `true` when a 200 is returned — the zero-match case is the
 * 404, never `{ restored: false }`.
 *
 * No audit event is written — see the note in remove.ts: the REST surface has no
 * audit writer, so this deliberately does not invent a second one.
 */
export async function handleRestore(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const tracedDb = createTracedClient(db, span);
  span.setAttributes({ 'lorekit.operation': 'memories.restore' });

  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .update({ archived_at: null }, { count: 'exact' })
    .not('archived_at', 'is', null);

  if (params.id) {
    const v = validateUuid(params.id, cors);
    if (!v.ok) return v.response;
    span.setAttributes({ 'lorekit.memory_id': v.data });
    q = q.eq('id', v.data);
  } else {
    const validated = await validateBody(req, RestoreMemoryBodySchema, cors);
    if (!validated.ok) return validated.response;
    const { scope, key } = validated.data;
    span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });
    q = q.eq('scope', scope).eq('key', key);
  }

  // api_key auth uses service-role client — restrict to caller's own rows.
  // JWT auth uses RLS-scoped client — RLS handles access control.
  if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId);

  const { count, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const restored = (count ?? 0) > 0;
  span.setAttributes({ 'lorekit.result.restored': restored });
  if (!restored) return notFound('Archived memory', cors);
  return ok({ restored: true }, cors);
}
