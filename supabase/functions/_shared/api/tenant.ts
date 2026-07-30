/**
 * Tenant-scoping helpers for REST handlers.
 *
 * REST api_key auth uses the service-role Supabase client (bypasses RLS).
 * Every read query must apply applyRestTenantScope so users only see their
 * own memories plus org-shared memories. JWT auth uses an RLS-scoped client,
 * so no filtering is needed — RLS handles it automatically.
 *
 * This module mirrors the logic in supabase/functions/mcp/tenant-scope.ts and
 * packages/mcp-core/src/tenant-scope.ts but is specific to the REST shared
 * API (different import chain, different span naming).
 */
import { createTracedClient } from '../otel.ts';
import type { Span, TracedQuery } from '../otel.ts';
import type { DbClient } from './auth.ts';

/**
 * Resolve the org IDs the user is a member of via the single-source RPC.
 * Fails closed — any RPC error returns an empty array (personal-only filter).
 * A `lorekit.rest.auth.org_ids` child span is created for observability.
 */
export async function getMemberOrgIds(db: DbClient, userId: string, parentSpan: Span): Promise<string[]> {
  const span = parentSpan.child('lorekit.rest.auth.org_ids');
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<string>('lorekit_member_org_ids', { p_user_id: userId });
  if (error) {
    span.setAttributes({ 'auth.org_ids_error': error.message }).end();
    return [];
  }
  const ids = (data ?? []) as string[];
  span.setAttributes({ 'lorekit.org_count': ids.length }).end();
  return ids;
}

/**
 * Apply tenant scoping to a query for api_key callers (service-role client).
 * JWT callers use RLS — do not apply this filter for them.
 *
 * Returns the query unchanged when auth.type === 'service' (CI — full access).
 */
export function applyRestTenantScope<Q extends TracedQuery<unknown>>(
  q: Q,
  userId: string,
  orgIds: string[],
): Q {
  if (orgIds.length === 0) {
    return q.eq('user_id', userId) as Q;
  }
  const quoted = orgIds.map((id) => `"${id}"`).join(',');
  return q.or(`user_id.eq.${userId},org_id.in.(${quoted})`) as Q;
}
