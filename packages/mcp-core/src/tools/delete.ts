import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

export const DeleteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  /**
   * When true, permanently hard-delete the row instead of soft-archiving it.
   * Defaults to false (soft-archive). Use with caution — hard-deleted rows
   * cannot be restored.
   */
  force: z.boolean().optional().default(false),
});

/**
 * Delete (or soft-archive) a memory.
 *
 * Default behaviour (force: false): sets archived_at on the row. The memory is
 * hidden from normal reads but can be listed via memory.list_archived and
 * restored via memory.restore. It will be permanently deleted by the purge job
 * after the configured retention window (default 30 days).
 *
 * With force: true: the row is immediately hard-deleted and cannot be recovered.
 */
export async function deleteMemory(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ deleted: boolean; archived: boolean }> {
  const input = DeleteInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.delete', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.delete');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    span.setAttribute('lorekit.key', input.key);
    span.setAttribute('lorekit.delete.force', input.force);

    try {
      if (input.force) {
        // Hard delete — immediate, irreversible.
        const { error, count } = await db
          .from('memories')
          .delete({ count: 'exact' })
          .eq('scope', input.scope)
          .eq('key', input.key);

        if (error) throw error;
        const deleted = (count ?? 0) > 0;
        span.setAttribute('lorekit.result.deleted', deleted);
        span.setAttribute('lorekit.result.archived', false);
        return { deleted, archived: false };
      } else {
        // Soft-archive — set archived_at, hide from normal reads.
        const { error, count } = await db
          .from('memories')
          .update({ archived_at: new Date().toISOString() }, { count: 'exact' })
          .eq('scope', input.scope)
          .eq('key', input.key)
          .is('archived_at', null);

        if (error) throw error;
        const archived = (count ?? 0) > 0;
        span.setAttribute('lorekit.result.deleted', false);
        span.setAttribute('lorekit.result.archived', archived);
        return { deleted: false, archived };
      }
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.delete',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}
