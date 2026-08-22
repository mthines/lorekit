import { SpanStatusCode } from '@opentelemetry/api';
import { type SupabaseClient } from '@supabase/supabase-js';
import { getTracer, getToolDurationHistogram } from '../telemetry/telemetry.js';
import { recordAudit } from '../audit/audit.js';

/**
 * Hard-delete active memories whose expires_at is in the past.
 *
 * This is complementary to purgeArchived (which removes soft-archived rows).
 * Callers without a userId cannot scope the purge and are rejected —
 * service-role callers must provide the target user's userId.
 *
 * Returns { purged: number } — count of permanently deleted rows.
 */
export async function purgeExpired(
  db: SupabaseClient,
  userId: string | null,
): Promise<{ purged: number }> {
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.purge_expired', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.purge_expired');
    if (userId) span.setAttribute('lorekit.purge.user_id', userId);

    try {
      if (!userId) {
        throw new Error(
          'memory.purge (expired) requires a user_id — service-role callers must supply userId',
        );
      }

      const { data, error } = await db.rpc('purge_expired_memories', {
        p_user_id: userId,
      });

      if (error) throw error;
      const purged = (data as number) ?? 0;
      span.setAttribute('lorekit.result.purged_expired', purged);

      if (purged > 0) {
        await recordAudit(
          db,
          {
            action: 'memory.delete',
            resourceType: 'memory',
            target: `${purged} expired memories`,
            metadata: { purged_expired: purged },
          },
          userId,
        );
      }
      return { purged };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.purge_expired',
        'lorekit.scope.type': 'global',
      });
    }
  });
}
