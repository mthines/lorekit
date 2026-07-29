import { SpanStatusCode } from '@opentelemetry/api';
import { type SupabaseClient } from '@supabase/supabase-js';
import { PurgeInputSchema, type PurgeInput, PURGE_RETENTION_DAYS_DEFAULT } from '@lorekit/schemas/memory.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';
import { recordAudit } from '../audit.js';

export { PurgeInputSchema, type PurgeInput, PURGE_RETENTION_DAYS_DEFAULT };

/**
 * Hard-delete archived memories whose archived_at is older than retention_days.
 *
 * SECURITY: The DB function purge_archived_memories() is SECURITY DEFINER and
 * accepts p_user_id, so each caller only purges their own rows. The tool layer
 * must pass userId explicitly; service-role callers should pass the target user's
 * id or run the RPC directly.
 *
 * Returns { purged: number } — count of permanently deleted rows.
 */
export async function purgeArchived(
  db: SupabaseClient,
  raw: unknown,
  userId: string | null,
): Promise<{ purged: number }> {
  const input = PurgeInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.purge', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.purge');
    span.setAttribute('lorekit.purge.retention_days', input.retention_days);
    if (userId) span.setAttribute('lorekit.purge.user_id', userId);

    try {
      if (!userId) {
        // Without a user_id we cannot safely scope the purge.
        // Service-role callers must provide userId; refuse rather than purging all users.
        throw new Error('memory.purge requires a user_id — service-role callers must supply userId');
      }

      const { data, error } = await db.rpc('purge_archived_memories', {
        p_user_id: userId,
        p_retention_days: input.retention_days,
      });

      if (error) throw error;
      const purged = (data as number) ?? 0;
      span.setAttribute('lorekit.result.purged', purged);
      if (purged > 0) {
        // One summary event per purge run (D6) — the RPC returns only a
        // count, not the purged rows, so a per-row audit event isn't possible.
        await recordAudit(
          db,
          {
            action: 'memory.delete',
            resourceType: 'memory',
            target: `${purged} archived memories`,
            metadata: { purged, retention_days: input.retention_days },
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
        'lorekit.tool.name': 'memory.purge',
        'lorekit.scope.type': 'global',
      });
    }
  });
}
