import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';
import { translateCapError } from '../limits.js';
import { parseCreatedAt } from '../created-at.js';

const MAX_VALUE_BYTES = 65_536;

export const WriteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(),
  trigger: z.string().optional(),
  // Optional creation-date override for migrating pre-existing memories. When
  // omitted the DB applies its now() default. Validated (and future-dates
  // rejected) by parseCreatedAt below, not by zod, so the error message and the
  // clock-skew rule stay shared with the edge mirror.
  created_at: z.string().optional(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export async function write(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ id: string; created_at: string }> {
  const input = WriteInputSchema.parse(raw);
  const createdAt = parseCreatedAt(input.created_at);
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
      if (createdAt) span.setAttribute('lorekit.created_at', createdAt);

      try {
        // 00003 replaced the plain unique constraint with PARTIAL indexes
        // (WHERE archived_at IS NULL), which `.upsert(onConflict)` cannot target.
        // Writes go through the memory_write RPC (00007) instead.
        const { data, error } = await db
          .rpc('memory_write', {
            p_user_id: null,
            p_scope: input.scope,
            p_key: input.key,
            p_value: input.value,
            p_tags: input.tags,
            p_source_agent: input.source_agent ?? null,
            p_trigger: input.trigger ?? null,
            p_created_at: createdAt,
          })
          .single();

        if (error) throw translateCapError(error);

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
