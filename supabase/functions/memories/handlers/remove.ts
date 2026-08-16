import { applyKeyScopeFilter, firstDeniedScope } from '../../_shared/api/tenant.ts';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit.ts';
import { noContent, notFound, badRequest, dryRun, forbidden } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/dry-run.ts';
import { validateUuid, validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { DeleteMemoryQuerySchema } from '../../_shared/schemas/memory.ts';
import { translateDbError } from '../../_shared/api/errors.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

/**
 * DELETE /memories/:id and DELETE /memories?scope=…&key=…[&org=…]
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
 * fail the request (recordAudit does not throw). The 404 path writes nothing:
 * an audit row asserts a mutation happened, and on a zero-match delete none
 * did.
 *
 * `?org=<slug>` routes through the role-gated `memory_delete` SECURITY DEFINER
 * RPC (00020_memory_delete_org.sql) instead of a direct query, for the reason
 * that migration exists: the api_key tier runs on a service-role client that
 * bypasses RLS, so a raw `.delete()`/`.update()` against an org-owned row would
 * skip the `lorekit_org_can` role gate entirely. A denial arrives as SQLSTATE
 * `LK002`, which `translateDbError` maps to a 403 — it is translated here at the
 * call site rather than left to bubble, so the code can never be swallowed by a
 * generic 500 path.
 */
export async function handleRemove(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, DeleteMemoryQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const { scope: scopeParam, key: keyParam, force: forceParam, org: orgParam } = validated.data;
  const force = forceParam === 'true';
  const idParam = params.id;

  const tracedDb = createTracedClient(db, span);
  const now = new Date().toISOString();
  span.setAttributes({
    'lorekit.operation': 'memories.remove',
    'lorekit.delete.force': force,
    ...(orgParam ? { 'lorekit.org': orgParam } : {}),
  });

  // Early refusal for a NAMED scope outside the key's allowlist (00067), hoisted
  // ABOVE the `?org=` dispatch on purpose. `applyKeyScopeFilter` below is a query
  // filter, and the org branch has no query to filter — it returns through
  // `removeOrgOwned`, whose `memory_delete` RPC chooses the rows itself — so a
  // gate placed further down covers only the personal branch and leaves
  // `DELETE /memories?scope=…&key=…&org=…` with no key gate at all.
  //
  // Here it also upgrades the personal scope+key form from an empty match (404)
  // to the plain 403 `handleCreate` already returns for the same situation: when
  // the request NAMES a scope, "your token may not use it" is the honest answer,
  // where "not found" sends the caller hunting a data bug.
  const deniedScope = firstDeniedScope(auth, [scopeParam]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  if (orgParam) {
    return await removeOrgOwned(
      { tracedDb, db, auth, span, cors },
      { org: orgParam, scope: scopeParam, key: keyParam, force, idParam },
    );
  }

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
  // The allowlist half. `user_id` alone let a scoped key delete a memory outside
  // its allowlist by id.
  q = applyKeyScopeFilter(q, auth);

  // Dry-run: everything above validated + authorized; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

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

interface OrgRemoveCtx {
  tracedDb: ReturnType<typeof createTracedClient>;
  db: DbClient;
  auth: AuthContext;
  span: Span;
  cors: Record<string, string>;
}

interface OrgRemoveInput {
  org: string;
  scope?: string | undefined;
  key?: string | undefined;
  force: boolean;
  idParam?: string | undefined;
}

/**
 * The `?org=` branch. Calls `memory_delete` with exactly the argument set
 * `toolDelete` uses (`p_user_id`, `p_org_slug`, `p_scope`, `p_key`, `p_force`)
 * so the two surfaces cannot drift on the role gate.
 */
async function removeOrgOwned(
  { tracedDb, db, auth, span, cors }: OrgRemoveCtx,
  { org, scope, key, force, idParam }: OrgRemoveInput,
): Promise<Response> {
  // The RPC is keyed on the natural key (org_id + scope + key); it has no id
  // parameter at all. Silently ignoring `org` on the `/:id` form would delete
  // the caller's PERSONAL row while they believed they were deleting the org's,
  // so the combination is refused outright.
  if (idParam) {
    return badRequest(
      'The org form of DELETE is addressed by scope+key, not by id — use DELETE /memories?scope=…&key=…&org=…',
      undefined,
      cors,
    );
  }
  if (!scope || !key) {
    return badRequest('Deleting org-owned lore requires both scope and key query params', undefined, cors);
  }

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const { data, error } = await tracedDb
    .rpc<{ deleted: boolean; archived: boolean }>('memory_delete', {
      p_user_id: auth.userId ?? null,
      p_org_slug: org,
      p_scope: scope,
      p_key: key,
      p_force: force,
    })
    .single();

  if (error) {
    // LK002 (org_permission_denied) -> 403. Translated here rather than rethrown
    // so the mapping cannot be lost to a generic error path.
    const mapped = translateDbError(error);
    if (mapped) return mapped.toResponse(cors);
    // The RPC raises `unknown_org` (P0001) for a slug it cannot resolve — the
    // same signal `memory_write` uses. `translateDbError` has no P0001 entry, so
    // without this it would fall through to a 500 for what is plainly a
    // client-addressable "no such thing". A slug that does not exist and a row
    // that does not exist are both `404 Organization not found` / `Memory not
    // found`; distinguishing them here would say nothing a caller can act on.
    if (typeof error.message === 'string' && error.message.includes('unknown_org')) {
      return notFound('Organization', cors);
    }
    span.error(`DB: ${error.message}`);
    throw error;
  }

  const row = data as { deleted: boolean; archived: boolean } | null;
  const deleted = row?.deleted === true;
  const archived = row?.archived === true;
  span.setAttributes({ 'lorekit.result.deleted': deleted, 'lorekit.result.archived': archived });

  // Same rule as the personal branch: no match, no mutation, no audit row.
  if (!deleted && !archived) return notFound('Memory', cors);

  // `deleted ? … : …` (not `force ? … : …`) mirrors toolDelete: the action names
  // what the RPC actually did, which is the authority on the outcome.
  await recordAudit(
    db,
    {
      action: deleted ? 'memory.delete' : 'memory.archive',
      resourceType: 'memory',
      target: key,
      metadata: { scope, key, force, org },
    },
    auditUserId(auth),
  );

  return noContent(cors);
}
