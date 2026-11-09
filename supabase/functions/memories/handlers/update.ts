import { applyKeyScopeFilter } from '../../_shared/api/tenant.ts';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { ok, notFound, badRequest, dryRun, versionConflict } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateUuid, validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { TracedQuery, Span } from '../../_shared/telemetry/otel.ts';
import { UpdateMemoryBodySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { NOT_EXPIRED } from '../../_shared/memory/live.ts';
import {
  parseExpectedVersion,
  RecordFieldError,
  translateRecordFieldDbError,
  VersionConflictError,
} from '../../_shared/provenance/record-extensions.ts';

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
  const { ttl_days: ttlDays, clear_ttl: clearTtl, expected_version: rawExpected, ...columns } = bodyV.data as Record<string, unknown> & {
    ttl_days?: number; clear_ttl?: boolean; expected_version?: unknown;
  };
  // `expected_version` (00120) is not a column either: it becomes a predicate
  // on the UPDATE itself, so the check and the write are one statement.
  let expectedVersion: number | null;
  try {
    expectedVersion = parseExpectedVersion(rawExpected);
  } catch (err) {
    if (err instanceof RecordFieldError) return badRequest(err.message, undefined, cors);
    throw err;
  }
  if (expectedVersion !== null) span.setAttributes({ 'lorekit.expected_version': expectedVersion });

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
  // The row this caller may patch: live (unarchived AND unexpired — the same
  // predicate as GET /:id, so PATCH cannot edit a row GET 404s on, and an
  // expired row's version never reaches the 409 path: it is absent, as in
  // memory_write), its own (api_key — the service-role client bypasses RLS) or
  // RLS-visible (JWT, org-owned rows included), and inside the key's allowlist
  // (`user_id` alone let a scoped key patch a memory outside its allowlist by
  // id). One definition, used by the update and by the version-conflict lookup
  // below, so the two cannot disagree on "which row".
  const target = <Q extends TracedQuery<MemoryRow>>(query: Q): Q => {
    let q = query.eq('id', idV.data).is('archived_at', null).or(NOT_EXPIRED) as Q;
    if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId) as Q;
    return applyKeyScopeFilter(q, auth);
  };
  let q: TracedQuery<MemoryRow> = target(tracedDb.from('memories').update(patch));
  if (expectedVersion !== null) q = q.eq('version', expectedVersion);

  // Dry-run: everything above validated + authorized; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const { data, error } = await q
    .select(MEMORY_SELECT)
    .maybeSingle();

  if (error) {
    // A new value on an application/json record must still parse; the table
    // constraint says so, and the caller gets a 400, not a 500.
    const fieldError = translateRecordFieldDbError(error);
    if (fieldError instanceof RecordFieldError) return badRequest(fieldError.message, undefined, cors);
    span.error(`DB: ${error.message}`);
    throw error;
  }
  // Audit only when the update actually matched a row — the REST analogue of
  // the MCP tools' `if (archived)` / `if (deleted)` guards. A 404 changed
  // nothing and must not leave an audit trail claiming otherwise.
  if (!data) {
    // With an expected_version, no row means either "no such memory" or "it
    // moved on". Tell them apart under the SAME visibility as the update, so a
    // 409 never reveals a row the caller could not have patched.
    if (expectedVersion !== null) {
      const { data: current, error: currentError } = await target(
        tracedDb.from('memories').select('version'),
      ).maybeSingle();
      if (currentError) { span.error(`DB: ${currentError.message}`); throw currentError; }
      const currentVersion = (current as { version?: number } | null)?.version;
      if (typeof currentVersion === 'number') {
        return versionConflict(new VersionConflictError(expectedVersion, currentVersion), cors);
      }
    }
    return notFound('Memory', cors);
  }

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
    span,
  );
  return ok(shapeMemoryRow(data as Record<string, unknown>), cors);
}
