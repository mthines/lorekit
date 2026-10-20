import type { AuthContext } from '../../_shared/api/auth.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import { ok, forbidden } from '../../_shared/api/respond.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { memoryQuotaFromRow, type MemoryCountRow } from '../../_shared/limits/memory-quota.ts';

/**
 * GET /memories/quota — the caller's active memories against their plan's cap,
 * and how many writes are left before `POST /memories` is refused with
 * `memory_cap`. The REST twin of the `memory.quota` MCP tool and `lorekit quota`.
 *
 * The count lives in Postgres (`lorekit_memory_count`, actor-guarded by 00047:
 * a caller-supplied user id is honoured only on a service-role connection), so
 * this handler only shapes it — see `memoryQuotaFromRow` for why the answer is
 * the PERSONAL pair rather than the RPC's combined count.
 *
 * Counts only, never a scope or key name, so a scope-restricted key may read it:
 * there is nothing for `p_key_scopes` to narrow (the same reason `/usage` is not
 * name-bearing). A service-role caller has no user whose cap this could be, so
 * it is refused rather than answered with zeros that look like an empty account.
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
