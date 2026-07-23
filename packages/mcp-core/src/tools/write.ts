import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

const MAX_VALUE_BYTES = 65_536;

export const WriteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(),
  trigger: z.string().optional(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export async function write(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ id: string; created_at: string }> {
  const input = WriteInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan(
    'lorekit.memory.write',
    { kind: 0 /* INTERNAL */ },
    async (span) => {
      span.setAttribute('lorekit.tool.name', 'memory.write');
      span.setAttribute('lorekit.scope', input.scope);
      span.setAttribute('lorekit.scope.type', scopeType(input.scope));
      span.setAttribute('lorekit.key', input.key);
      if (input.source_agent) span.setAttribute('lorekit.source_agent', input.source_agent);
      if (input.trigger) span.setAttribute('lorekit.trigger', input.trigger);

      try {
        const { data, error } = await db
          .from('memories')
          .upsert(
            {
              scope: input.scope,
              key: input.key,
              value: input.value,
              tags: input.tags,
              source_agent: input.source_agent ?? null,
              trigger: input.trigger ?? null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,scope,key' },
          )
          .select('id,created_at')
          .single();

        if (error) throw error;

        span.setStatus({ code: SpanStatusCode.UNSET });
        return data as { id: string; created_at: string };
      } catch (err) {
        const e = err as Error;
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `${e.name}: ${e.message}`,
        });
        throw err;
      } finally {
        span.end();
        hist.record((Date.now() - startTime) / 1000, {
          'lorekit.tool.name': 'memory.write',
          'lorekit.scope.type': scopeType(input.scope),
        });
      }
    },
  );
}
