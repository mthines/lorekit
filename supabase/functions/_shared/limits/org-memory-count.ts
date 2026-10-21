/**
 * The org half of `lorekit_memory_count`, recounted over a subset of the caller's orgs, for
 * `quotaForKey` (`memory-quota.ts`). Shared by `GET /memories/quota` and `memory.quota`.
 * Edge-only I/O, so it has no mcp-core twin; the decision about WHICH orgs lives in the
 * mirrored, unit-tested `quotaForKey`.
 */

import type { DbClient } from '../db/db-client.ts';
import { createTracedClient, type Span } from '../telemetry/otel.ts';

/**
 * Active (non-archived) org-owned memories across `orgIds`, matching the RPC's own org count.
 * @throws Error when the count query fails; the caller must not fall back to a wider figure.
 */
export async function countActiveOrgMemories(db: DbClient, span: Span, orgIds: string[]): Promise<number> {
  if (orgIds.length === 0) return 0;
  // The api_key path runs on the service-role client, which bypasses RLS: `orgIds` must already be
  // membership ∩ the key's tenancy (`effectiveOrgIds`), because this filter is the whole boundary.
  const { count, error } = await createTracedClient(db, span)
    .from('memories')
    .select('id', { head: true, count: 'exact' })
    .in('org_id', orgIds)
    .is('archived_at', null);
  if (error) {
    span.error(`DB: ${error.message}`);
    throw new Error(error.message);
  }
  return count ?? 0;
}
