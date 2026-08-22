import { applyKeyScopeFilter, firstDeniedScope } from '../../_shared/api/tenant.ts';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId, keyRestriction } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit.ts';
import { badRequest, ok, notFound, dryRun, forbidden } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/dry-run.ts';
import { validateBody, validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { RestoreMemoryBodySchema } from '../../_shared/schemas/memory.ts';
import { parseScopeFilter } from '../../_shared/scope.ts';
import { translateDbError } from '../../_shared/api/errors.ts';
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

  // The scope+key (body) form routes through the restore_memory RPC (00072), so
  // a scoped key restores any writer's row within its allowlist — symmetric with
  // memory.delete / memory.archive — and `existed` distinguishes 403 (present,
  // not this token's to restore) from 404. The `/:id` form has no scope+key for
  // the RPC's natural key, so it stays a direct own-row update below.
  if (!params.id) {
    const validated = await validateBody(req, RestoreMemoryBodySchema, cors);
    if (!validated.ok) return validated.response;
    const { scope: rawScope, key } = validated.data;
    // Natural-key restore addresses a row by scope+key, so the same rule as
    // DELETE applies: an ungrammatical scope must be named as bad input, not
    // reported back as "no such memory".
    // `RestoreMemoryBodySchema.scope` is required, so `parseScopeFilter` — whose
    // signature is `undefined` in, `undefined` out — cannot return undefined
    // here. Narrow once at the assignment rather than asserting at each use.
    let scope: string;
    try {
      scope = parseScopeFilter(rawScope) as string;
    } catch (e) {
      return badRequest((e as Error).message, undefined, cors);
    }
    span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });
    const denied = firstDeniedScope(auth, [scope]);
    if (denied !== null) {
      span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
      return forbidden(
        `This token is not allowed to use the scope "${denied}". It is restricted to specific scopes.`,
        cors,
      );
    }

    if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

    const { data, error } = await tracedDb
      .rpc<{ restored: boolean; existed: boolean }>('restore_memory', {
        p_user_id: auth.userId ?? null,
        p_scope: scope,
        p_key: key,
        p_key_scopes: keyRestriction(auth)?.scopes ?? [],
        p_key_org_access: keyRestriction(auth)?.orgAccess ?? 'all',
        p_key_org_ids: keyRestriction(auth)?.orgIds ?? [],
      })
      .single();
    if (error) {
      const mapped = translateDbError(error);
      if (mapped) return mapped.toResponse(cors);
      span.error(`DB: ${error.message}`);
      throw error;
    }
    const row = data as { restored: boolean; existed: boolean } | null;
    const restored = row?.restored === true;
    span.setAttributes({ 'lorekit.result.restored': restored });
    if (!restored) {
      return row?.existed
        ? forbidden('This token is not allowed to restore that memory.', cors)
        : notFound('Archived memory', cors);
    }
    await recordAudit(
      db,
      { action: 'memory.restore', resourceType: 'memory', target: key, metadata: { scope, key } },
      auditUserId(auth),
    );
    return ok({ restored: true }, cors);
  }

  // `/:id` form: direct own-row update, narrowed by user_id + the key allowlist.
  const v = validateUuid(params.id, cors);
  if (!v.ok) return v.response;
  span.setAttributes({ 'lorekit.memory_id': v.data });
  let q: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .update({ archived_at: null }, { count: 'exact' })
    .not('archived_at', 'is', null)
    .eq('id', v.data);
  if (auth.type === 'api_key' && auth.userId) q = q.eq('user_id', auth.userId);
  q = applyKeyScopeFilter(q, auth);

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

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
