import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit.ts';
import { badRequest, ok, notFound, dryRun } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/dry-run.ts';
import { validateBody, validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { RestoreMemoryBodySchema } from '../../_shared/schemas/memory.ts';
import { parseScopeFilter } from '../../_shared/scope.ts';
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
 * Audits `memory.restore` through the one shared edge writer
 * (`_shared/audit.ts`), with toolRestore's exact resourceType/target/metadata
 * shape, and only when a row was actually restored.
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
    const { scope: rawScope, key } = validated.data;
    // Natural-key restore addresses a row by scope+key, so the same rule as
    // DELETE applies: an ungrammatical scope must be named as bad input, not
    // reported back as "no such memory".
    let scope: string | undefined;
    try {
      scope = parseScopeFilter(rawScope);
    } catch (e) {
      return badRequest((e as Error).message, undefined, cors);
    }
    span.setAttributes({ 'lorekit.scope': scope as string, 'lorekit.key': key });
    q = q.eq('scope', scope as string).eq('key', key);
  }

  // api_key auth uses service-role client — restrict to caller's own rows.
  // JWT auth uses RLS-scoped client — RLS handles access control.
  if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId);

  // Dry-run: everything above validated + authorized; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  // `.select()` returns the affected rows: the `/:id` form has no scope+key of
  // its own, and the audit row needs them to match the MCP surface's shape.
  const { data, count, error } = await q.select('id,scope,key');
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const restored = (count ?? 0) > 0;
  span.setAttributes({ 'lorekit.result.restored': restored });
  if (!restored) return notFound('Archived memory', cors);

  const actor = auditUserId(auth);
  for (const row of ((data ?? []) as unknown as Array<{ scope: string; key: string }>)) {
    await recordAudit(
      db,
      { action: 'memory.restore', resourceType: 'memory', target: row.key, metadata: { scope: row.scope, key: row.key } },
      actor,
    );
  }
  return ok({ restored: true }, cors);
}
