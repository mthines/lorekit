import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';

export const ArchiveInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export const RestoreInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export const ListArchivedInputSchema = z.object({
  scope: ScopeSchema,
  limit: z.number().int().min(1).max(100).optional().default(50),
});

export interface ArchivedEntry {
  key: string;
  value: string;
  tags: string[];
  updated_at: string;
  archived_at: string;
}

/**
 * Soft-archive a memory by setting archived_at.
 * The row is hidden from normal reads but can be listed and restored.
 */
export async function archiveMemory(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ archived: boolean }> {
  const input = ArchiveInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.archive', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.archive');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    span.setAttribute('lorekit.key', input.key);

    try {
      const { error, count } = await db
        .from('memories')
        .update({ archived_at: new Date().toISOString() }, { count: 'exact' })
        .eq('scope', input.scope)
        .eq('key', input.key)
        .is('archived_at', null);

      if (error) throw error;
      const archived = (count ?? 0) > 0;
      span.setAttribute('lorekit.result.archived', archived);
      return { archived };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.archive',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}

/**
 * Restore a soft-archived memory by clearing archived_at.
 */
export async function restoreMemory(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ restored: boolean }> {
  const input = RestoreInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.restore', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.restore');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    span.setAttribute('lorekit.key', input.key);

    try {
      const { error, count } = await db
        .from('memories')
        .update({ archived_at: null }, { count: 'exact' })
        .eq('scope', input.scope)
        .eq('key', input.key)
        .not('archived_at', 'is', null);

      if (error) throw error;
      const restored = (count ?? 0) > 0;
      span.setAttribute('lorekit.result.restored', restored);
      return { restored };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.restore',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}

/**
 * List archived memories for a scope.
 */
export async function listArchived(
  db: SupabaseClient,
  raw: unknown,
): Promise<{ entries: ArchivedEntry[] }> {
  const input = ListArchivedInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.list_archived', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.list_archived');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));

    try {
      const { data, error } = await db
        .from('memories')
        .select('key,value,tags,updated_at,archived_at')
        .eq('scope', input.scope)
        .not('archived_at', 'is', null)
        .order('archived_at', { ascending: false })
        .limit(input.limit);

      if (error) throw error;
      const entries = (data ?? []) as ArchivedEntry[];
      span.setAttribute('lorekit.result.count', entries.length);
      return { entries };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.list_archived',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}
