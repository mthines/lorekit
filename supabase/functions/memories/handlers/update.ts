import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit.ts';
import { ok, notFound, badRequest, dryRun } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/dry-run.ts';
import { validateUuid, validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { UpdateMemoryBodySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
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

  // ttl_days / clear_ttl are TTL INTENTIONS, not columns. They used to be copied
  // straight into the column patch alongside value/tags, so PostgREST was asked
  // to set a `ttl_days` column that does not exist and every request carrying
  // one failed — the reason the dashboard's edit form could not go through this
  // route at all. They are translated into `expires_at` here: clear wins over
  // set (mirroring memory_write's p_clear_ttl precedence, 00031), and the
  // deadline is computed from the request clock rather than the database's,
  // which is accurate to within clock skew and keeps this a plain column patch.
  const { ttl_days: ttlDays, clear_ttl: clearTtl, ...columns } = bodyV.data as Record<string, unknown> & {
    ttl_days?: number; clear_ttl?: boolean;
  };

  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(columns)) { if (v !== undefined) patch[k] = v; }
  if (clearTtl) patch['expires_at'] = null;
  else if (typeof ttlDays === 'number') {
    patch['expires_at'] = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  }

  // A body of only `clear_ttl: false` patches nothing; the schema's
  // at-least-one-field refinement passed, but there is no column to write.
  if (Object.keys(patch).length === 0) {
    return badRequest('PATCH body must change at least one field', undefined, cors);
  }

  const tracedDb = createTracedClient(db, span);
  let q: TracedQuery<MemoryRow> = tracedDb.from<MemoryRow>('memories').update(patch).eq('id', idV.data).is('archived_at', null);
  // api_key auth uses service-role client — restrict to caller's own rows.
  // JWT auth uses RLS-scoped client — RLS handles access control (org-owned rows included).
  if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId);

  // Dry-run: everything above validated + authorized; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const { data, error } = await q
    .select(MEMORY_SELECT)
    .maybeSingle();

  if (error) { span.error(`DB: ${error.message}`); throw error; }
  // Audit only when the update actually matched a row — the REST analogue of
  // the MCP tools' `if (archived)` / `if (deleted)` guards. A 404 changed
  // nothing and must not leave an audit trail claiming otherwise.
  if (!data) return notFound('Memory', cors);

  const updated = data as unknown as { id: string; scope: string; key: string };
  await recordAudit(
    db,
    {
      action: 'memory.update',
      resourceType: 'memory',
      resourceId: updated.id,
      target: updated.key,
      metadata: { scope: updated.scope, key: updated.key },
    },
    auditUserId(auth),
  );
  return ok(shapeMemoryRow(data as Record<string, unknown>), cors);
}
