import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

/** Characters of `value` echoed in a `view: "summary"` entry's `preview`. */
export const LIST_PREVIEW_CHARS = 200;

export const ListInputSchema = z.object({
  scope: ScopeSchema,
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  // Taxonomy filters — the `kind`/`host` columns added in migration 00056.
  // Without these an MCP client can only filter by tag and must discard the
  // rest client-side, which is exactly the over-fetch `view: "summary"` below
  // is also aimed at.
  kind: z.enum(['lesson', 'bus', 'signal']).optional(),
  host: z.string().min(1).max(64).optional(),
  // `full` (default) keeps the historical entry shape. `summary` swaps `value`
  // for `value_bytes` + a bounded `preview`, turning a 50-entry read from
  // ~95 KB of caller context into ~12 KB of index the caller can then resolve
  // with targeted `memory.read` calls.
  view: z.enum(['full', 'summary']).optional().default('full'),
});

export type ListInput = z.infer<typeof ListInputSchema>;

export interface ListEntry {
  key: string;
  value: string;
  tags: string[];
  updated_at: string;
}

export interface ListSummaryEntry {
  key: string;
  tags: string[];
  updated_at: string;
  value_bytes: number;
  preview: string;
}

/**
 * Project a row for the wire.
 *
 * `value_bytes` is the BYTE length so it is comparable with `MAX_VALUE_BYTES`;
 * `String.length` would under-report a multi-byte body.
 *
 * `preview` slices `[...value]`, NOT `value.slice()`. String indices are UTF-16
 * code units, so cutting at a fixed index can land between a surrogate pair and
 * emit a lone half — an unpaired surrogate is not valid UTF-8 and survives a
 * JSON round-trip as U+FFFD. Spreading iterates code points, so an emoji or a
 * non-BMP character is either whole or absent.
 */
function summarizeEntry(entry: ListEntry): ListSummaryEntry {
  const { value, ...rest } = entry;
  return {
    ...rest,
    value_bytes: Buffer.byteLength(value ?? '', 'utf8'),
    preview: [...(value ?? '')].slice(0, LIST_PREVIEW_CHARS).join(''),
  };
}

export async function list(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ entries: ListEntry[] | ListSummaryEntry[] }> {
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
        // Exclude archived rows and expired rows (see read.ts for the rationale).
        .is('archived_at', null)
        .or('expires_at.is.null,expires_at.gt.now()')
        .limit(input.limit);

      if (input.tags && input.tags.length > 0) {
        query = query.overlaps('tags', input.tags);
      }
      if (input.kind) query = query.eq('kind', input.kind);
      if (input.host) query = query.eq('host', input.host);

      const { data, error } = await query.order('updated_at', { ascending: false });
      if (error) throw error;

      const entries = (data ?? []) as ListEntry[];
      span.setAttribute('lorekit.result.count', entries.length);
      return input.view === 'summary'
        ? { entries: entries.map(summarizeEntry) }
        : { entries };
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
