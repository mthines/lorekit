import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

export const DeleteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export async function deleteMemory(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ deleted: boolean }> {
  const input = DeleteInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.delete', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.delete');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    span.setAttribute('lorekit.key', input.key);

    try {
      const { error, count } = await db
        .from('memories')
        .delete({ count: 'exact' })
        .eq('scope', input.scope)
        .eq('key', input.key);

      if (error) throw error;
      const deleted = (count ?? 0) > 0;
      span.setAttribute('lorekit.result.deleted', deleted);
      return { deleted };
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
