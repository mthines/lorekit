import type { AuthContext } from '../../_shared/api/auth.ts';
import { noContent, notFound, badRequest } from '../../_shared/api/respond.ts';
import { validateUuid, validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { DeleteMemoryQuerySchema } from '@lorekit/schemas/memory';
import { translateDbError } from '../../_shared/api/errors.ts';
import { recordRestAudit } from '../../_shared/audit.ts';
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
 * `?org=<slug>` routes through the role-gated `memory_delete` SECURITY DEFINER
 * RPC (00020_memory_delete_org.sql) instead of a direct query, for the reason
 * that migration exists: the api_key tier runs on a service-role client that
 * bypasses RLS, so a raw `.delete()`/`.update()` against an org-owned row would
 * skip the `lorekit_org_can` role gate entirely. A denial arrives as SQLSTATE
 * `LK002`, which `translateDbError` maps to a 403 — it is translated here at the
 * call site rather than left to bubble, so the code can never be swallowed by a
 * generic 500 path.
 *
 * Audits `memory.delete` (hard) or `memory.archive` (soft), matching
 * toolDelete's action choice and metadata shape — but only once a row has
 * actually matched. The 404 path writes nothing: an audit row asserts a
 * mutation happened, and on a zero-match delete none did.
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

  const { count, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  // Nothing matched → nothing happened → no audit row. Emitting one here would
  // record a deletion that never occurred.
  if (!count || count === 0) return notFound('Memory', cors);
  span.setAttributes({ 'lorekit.result.deleted': force, 'lorekit.result.archived': !force });

  // Action + metadata mirror toolDelete (mcp/tools.ts). This route also accepts
  // the UUID form, which toolDelete has no equivalent of; in that case scope/key
  // are simply unknown, so the row carries the id as its target and omits them
  // rather than inventing values or paying for an extra lookup.
  await recordRestAudit(db, span, auth, {
    action: force ? 'memory.delete' : 'memory.archive',
    resourceType: 'memory',
    resourceId: idParam ?? null,
    target: keyParam ?? idParam ?? null,
    metadata: {
      force,
      ...(scopeParam && keyParam ? { scope: scopeParam, key: keyParam } : {}),
    },
  });

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
  await recordRestAudit(db, span, auth, {
    action: deleted ? 'memory.delete' : 'memory.archive',
    resourceType: 'memory',
    resourceId: null,
    target: key,
    metadata: { scope, key, force, org },
  });

  return noContent(cors);
}
