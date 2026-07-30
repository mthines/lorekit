import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/database.types.ts';

type ScopeRow = Database['public']['Functions']['lorekit_memory_scopes']['Returns'][number];

/**
 * GET /memories/scopes — every distinct scope the caller can see, with its
 * count of active (non-archived, non-expired) memories, sorted by scope asc.
 *
 * This is the REST answer to the CLI's `listScopes()`, which returns an
 * "unsupported" sentinel today because no MCP tool can enumerate scopes (every
 * read tool REQUIRES a scope).
 *
 * The aggregation is done in Postgres (`lorekit_memory_scopes`, migration
 * 00039), NOT by selecting `scope` and deduping here. A client-side dedupe —
 * which is what packages/web/src/lib/queries/lore.ts does — silently drops
 * whole scopes once the row count exceeds PostgREST's default cap: the response
 * is truncated with no error, so the caller dedupes a prefix and believes it saw
 * everything. One row per scope from the database is exact at any size.
 *
 * Tenant scoping lives in the RPC (it composes `lorekit_member_org_ids` exactly
 * as the memories RLS read policies do), so there is deliberately no
 * `applyRestTenantScope` call here — there is no query to scope, and a second
 * predicate would be a place for the two to drift.
 */
export async function handleScopes(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'memories.scopes' });

  const tracedDb = createTracedClient(db, span);
  // Service-role callers have no user id; the RPC recognises a null p_user_id
  // from a service_role JWT as "no tenant filter", matching GET /memories.
  const { data, error } = await tracedDb.rpc<ScopeRow>('lorekit_memory_scopes', {
    p_user_id: auth.userId ?? null,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const scopes = ((data ?? []) as ScopeRow[]).map((r) => ({ scope: r.scope, count: Number(r.count) }));
  span.setAttributes({ 'lorekit.result_count': scopes.length });
  return ok({ scopes }, cors);
}
