import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * EXECUTING cover for `recordMemoryReads`
 * (`supabase/functions/_shared/telemetry/memory-reads.ts`): the fire-and-forget
 * `lorekit_record_memory_reads` RPC must reach Dash0 as a
 * `CALL lorekit_record_memory_reads` CLIENT span, under a detached
 * `lorekit.memory.record_reads` span that keeps the request's trace id.
 *
 * Before this, the call used the raw client and emitted no span at all — the
 * one database write on every list/search/read path that the traces could not
 * see. A plain `child()` span would not fix it: the request batch is flushed
 * before the background call resolves (see `otel-detached-child.spec.ts`).
 *
 * Loaded by a dynamic import over a computed path, like that spec, because
 * `supabase/` is another NX project.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const telemetryDir = path.join(repoRoot, 'supabase', 'functions', '_shared', 'telemetry');
const { Span, ExportBatch } = (await import(pathToFileURL(path.join(telemetryDir, 'otel.ts')).href)) as {
  Span: new (
    name: string,
    ctx: { traceId: string; spanId: string; sampled: boolean },
    batch: unknown,
    kind?: number,
  ) => unknown;
  ExportBatch: new () => { drain(): unknown[] };
};
const { recordMemoryReads } = (await import(pathToFileURL(path.join(telemetryDir, 'memory-reads.ts')).href)) as {
  recordMemoryReads: (db: unknown, span: unknown, ids: readonly string[], kind: string, client?: string | null) => void;
};

const TRACE_ID = 'c'.repeat(32);
const SPAN_KIND_CLIENT = 3;

let posted: string[];
let realFetch: typeof globalThis.fetch;
let hadDeno: boolean;

beforeEach(() => {
  posted = [];
  realFetch = globalThis.fetch;
  hadDeno = 'Deno' in globalThis;
  (globalThis as Record<string, unknown>).Deno = {
    env: {
      get: (k: string) => (k === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? 'https://otlp.test.invalid' : undefined),
    },
  };
  globalThis.fetch = ((_url: string, init?: { body?: string }) => {
    posted.push(String(init?.body ?? ''));
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (!hadDeno) delete (globalThis as Record<string, unknown>).Deno;
});

type OtlpSpan = { name: string; kind: number; traceId: string; parentSpanId?: string; spanId: string };

function exportedSpans(): OtlpSpan[] {
  const out: OtlpSpan[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.name === 'string' && typeof o.spanId === 'string') out.push(o as unknown as OtlpSpan);
      Object.values(o).forEach(walk);
    }
  };
  posted.forEach((body) => walk(JSON.parse(body)));
  return out;
}

function fakeDb(calls: Array<{ fn: string; args: unknown }>, result: Promise<unknown> = Promise.resolve({ data: null, error: null })) {
  return {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return result;
    },
  };
}

describe('recordMemoryReads', () => {
  it('exports a CALL lorekit_record_memory_reads CLIENT span under a detached span of the request trace', async () => {
    const batch = new ExportBatch();
    const request = new Span('lorekit.memory.list', { traceId: TRACE_ID, spanId: 'd'.repeat(16), sampled: true }, batch, 1);
    const calls: Array<{ fn: string; args: unknown }> = [];

    recordMemoryReads(fakeDb(calls), request, ['m1', 'm2'], 'bulk');

    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(calls).toEqual([{ fn: 'lorekit_record_memory_reads', args: { p_memory_ids: ['m1', 'm2'], p_read_kind: 'bulk', p_client: null } }]);

    const spans = exportedSpans();
    const bg = spans.find((s) => s.name === 'lorekit.memory.record_reads');
    const call = spans.find((s) => s.name === 'CALL lorekit_record_memory_reads');
    expect(bg?.traceId).toBe(TRACE_ID);
    expect(bg?.parentSpanId).toBe('d'.repeat(16));
    expect(call?.kind).toBe(SPAN_KIND_CLIENT);
    expect(call?.parentSpanId).toBe(bg?.spanId);
    // Nothing landed in the request's own batch: it may already be flushed.
    expect(batch.drain()).toEqual([]);
  });

  it('still ends and exports the span when the RPC throws, and never throws itself', async () => {
    const request = new Span('lorekit.memory.read', { traceId: TRACE_ID, spanId: 'e'.repeat(16), sampled: true }, new ExportBatch(), 1);

    expect(() => recordMemoryReads(fakeDb([], Promise.reject(new Error('boom'))), request, ['m1'], 'targeted', 'mcp')).not.toThrow();

    await vi.waitFor(() => expect(exportedSpans().some((s) => s.name === 'lorekit.memory.record_reads')).toBe(true));
  });

  it('opens no span and makes no call for zero ids', async () => {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const detachedChild = vi.fn();

    recordMemoryReads(fakeDb(calls), { detachedChild }, [], 'bulk');

    await new Promise((r) => setTimeout(r, 10));
    expect(detachedChild).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(posted).toEqual([]);
  });
});
