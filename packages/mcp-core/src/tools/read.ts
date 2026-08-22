import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope/scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry/telemetry.js';

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
        // Filter out archived and expired rows — both are the query layer's
        // job, not RLS's. An owner's archived rows stay visible through the
        // rls_read_archived policy (see migrations.test.sql §60c), and RLS is
        // not expiry-aware, so this tool applies both filters itself.
        .is('archived_at', null)
        .or('expires_at.is.null,expires_at.gt.now()')
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
