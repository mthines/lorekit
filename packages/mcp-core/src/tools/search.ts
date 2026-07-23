import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { expandScopeForSearch, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

export const SearchInputSchema = z.object({
  q: z.string().min(1).max(512),
  scopes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export interface SearchEntry {
  key: string;
  value: string;
  scope: string;
  tags: string[];
  rank: number;
}

export async function search(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ entries: SearchEntry[] }> {
  const input = SearchInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.search', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.search');
    span.setAttribute('lorekit.search.query', input.q);
    if (input.scopes) span.setAttribute('lorekit.search.scope_count', input.scopes.length);

    try {
      // Use Postgres full-text search via the generated `fts` column
      let query = db
        .from('memories')
        .select('key,value,scope,tags')
        .textSearch('fts', input.q, { type: 'websearch', config: 'english' })
        .limit(input.limit);

      if (input.tags && input.tags.length > 0) {
        query = query.overlaps('tags', input.tags);
      }

      // Scope filtering: exact match or LIKE for wildcards
      if (input.scopes && input.scopes.length > 0) {
        const exactScopes: string[] = [];
        const likePatterns: string[] = [];

        for (const s of input.scopes) {
          const filter = expandScopeForSearch(s);
          if ('exact' in filter) exactScopes.push(filter.exact);
          else likePatterns.push(filter.like);
        }

        // Combine: scope IN (...) OR scope LIKE '...'
        // Supabase doesn't support OR across different columns easily in one call,
        // so we use .or() with a raw filter string
        const orParts: string[] = [];
        if (exactScopes.length > 0) {
          orParts.push(`scope.in.(${exactScopes.map((s) => `"${s}"`).join(',')})`);
        }
        for (const pat of likePatterns) {
          orParts.push(`scope.like.${pat}`);
        }
        if (orParts.length > 0) {
          query = query.or(orParts.join(','));
        }
      }

      const { data, error } = await query.order('fts', { ascending: false });
      if (error) throw error;

      // Supabase textSearch doesn't return a rank score directly; we assign position-based rank
      const entries: SearchEntry[] = ((data ?? []) as Array<{
        key: string;
        value: string;
        scope: string;
        tags: string[];
      }>).map((row, i) => ({
        ...row,
        rank: 1 - i * 0.05, // descending positional rank
      }));

      span.setAttribute('lorekit.result.count', entries.length);
      return { entries };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.search',
        'lorekit.scope.type': 'mixed',
      });
    }
  });
}
