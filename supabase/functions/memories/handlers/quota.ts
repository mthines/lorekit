import type { AuthContext } from '../../_shared/api/auth.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import { ok, forbidden } from '../../_shared/api/respond.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { memoryQuotaFromRow, type MemoryCountRow } from '../../_shared/limits/memory-quota.ts';

/**
 * GET /memories/quota — the caller's active memories against their plan's cap.
 * Counts only, so a scope-restricted key may read it; a service-role caller has
 * no cap and is refused rather than shown zeros that look like an empty account.
 */
export async function handleQuota(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'memories.quota' });
  if (!auth.userId) {
    return forbidden('Quota requires a user-scoped credential (service-role tokens have no user and no cap)', cors);
  }

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<MemoryCountRow>('lorekit_memory_count', {
    p_user_id: auth.userId,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const quota = memoryQuotaFromRow(data);
  span.setAttributes({
    'lorekit.plan': quota.plan,
    'lorekit.memory.count': quota.personal.count,
    'lorekit.memory.limit': quota.personal.limit,
  });
  return ok(quota, cors);
}
