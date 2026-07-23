import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

export const ListInputSchema = z.object({
  scope: ScopeSchema,
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
});

export type ListInput = z.infer<typeof ListInputSchema>;

export interface ListEntry {
  key: string;
  value: string;
  tags: string[];
  updated_at: string;
}

export async function list(db: SupabaseClient, raw: unknown): Promise<{ entries: ListEntry[] }> {
  const input = ListInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.list', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.list');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));

    try {
      let query = db
        .from('memories')
        .select('key,value,tags,updated_at')
        .eq('scope', input.scope)
        .limit(input.limit);

      if (input.tags && input.tags.length > 0) {
        query = query.overlaps('tags', input.tags);
      }

      const { data, error } = await query.order('updated_at', { ascending: false });
      if (error) throw error;

      const entries = (data ?? []) as ListEntry[];
      span.setAttribute('lorekit.result.count', entries.length);
      return { entries };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.list',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}
