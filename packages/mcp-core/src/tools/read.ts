import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

export const ReadInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadResult = { value: string; updated_at: string } | null;

export async function read(db: SupabaseClient, raw: unknown): Promise<ReadResult> {
  const input = ReadInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.read', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.read');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    span.setAttribute('lorekit.key', input.key);

    try {
      const { data, error } = await db
        .from('memories')
        .select('value,updated_at')
        .eq('scope', input.scope)
        .eq('key', input.key)
        .maybeSingle();

      if (error) throw error;
      span.setAttribute('lorekit.result.found', data !== null);
      return data ? { value: data.value as string, updated_at: data.updated_at as string } : null;
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.read',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}
