import type { AuthContext } from '../../_shared/api/auth.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { ok, forbidden } from '../../_shared/api/respond.ts';
import { getMemberOrgIds } from '../../_shared/api/tenant.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { memoryQuotaFromRow, quotaForKey, type MemoryCountRow } from '../../_shared/limits/memory-quota.ts';
import { countActiveOrgMemories } from '../../_shared/limits/org-memory-count.ts';

/**
 * GET /memories/quota — the caller's active memories against their plan's cap, with the org half
 * narrowed to the calling key's tenancy (`quotaForKey`); a service-role caller has no cap and is refused.
 */
export async function handleQuota(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'memories.quota' });
  const userId = auth.userId;
  if (!userId) {
    return forbidden('Quota requires a user-scoped credential (service-role tokens have no user and no cap)', cors);
  }

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<MemoryCountRow>('lorekit_memory_count', {
    p_user_id: userId,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const quota = await quotaForKey(memoryQuotaFromRow(data), keyRestriction(auth), {
    memberOrgIds: () => getMemberOrgIds(db, userId, span),
    countOrgMemories: (orgIds) => countActiveOrgMemories(db, span, orgIds),
  });
  span.setAttributes({
    'lorekit.plan': quota.plan,
    'lorekit.memory.count': quota.personal.count,
    'lorekit.memory.limit': quota.personal.limit,
  });
  return ok(quota, cors);
}
