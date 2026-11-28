/**
 * MCP `memory.write` with `edit: true` (00126): `toolWrite` sends `p_edit`
 * (and NULL tags when the edit omits them), and the RPC's `memory_not_found`
 * reaches the caller as a {@link MemoryNotFoundError}, which `mcp-handler.ts`
 * returns in-band as an `isError` result. A plain write's call is unchanged.
 *
 * Run with: deno test --no-check --node-modules-dir=none --allow-env supabase/functions/mcp/tools.write-edit.test.ts
 */
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ExportBatch, Span } from '../_shared/telemetry/otel.ts';
import { MemoryNotFoundError } from '../_shared/provenance/record-extensions.ts';
import { toolWrite } from './tools.ts';

const USER = '22222222-2222-4222-8222-222222222222';

function newSpan(): Span {
  return new Span('lorekit.test', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }, new ExportBatch(), 2);
}

function fakeDb(answer: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown>[] = [];
  // deno-lint-ignore no-explicit-any
  const thenable = (v: unknown): any => {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b, eq: () => b, is: () => b, in: () => b, or: () => b, single: () => b, maybeSingle: () => b,
      insert: () => b, update: () => b,
      then: (res: (x: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve(v).then(res, rej),
    };
    return b;
  };
  // deno-lint-ignore no-explicit-any
  const db: any = {
    from: () => thenable({ data: null, error: null }),
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name !== 'memory_write') return thenable({ data: null, error: null });
      calls.push(args);
      return thenable(answer);
    },
  };
  return { db, calls };
}

const ROW = { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-01-01T00:00:00Z', inserted: false, version: 3 };

Deno.test('memory.write with edit: true on a missing key throws MemoryNotFoundError', async () => {
  const { db, calls } = fakeDb({ data: null, error: { code: 'P0002', message: 'memory_not_found: scope=global key=k' } });
  await assertRejects(
    () => toolWrite(db, { scope: 'global', key: 'k', value: 'v', edit: true }, USER, newSpan()),
    MemoryNotFoundError,
    'memory_not_found',
  );
  assertEquals(calls[0].p_edit, true);
});

Deno.test('memory.write with edit: true sends p_edit and NULL tags when tags are omitted', async () => {
  const { db, calls } = fakeDb({ data: ROW, error: null });
  await toolWrite(db, { scope: 'global', key: 'k', value: 'v', edit: true }, USER, newSpan());
  assertEquals(calls[0].p_edit, true);
  assertEquals(calls[0].p_tags, null);
});

Deno.test('memory.write with edit: true and tags sends those tags', async () => {
  const { db, calls } = fakeDb({ data: ROW, error: null });
  await toolWrite(db, { scope: 'global', key: 'k', value: 'v', tags: ['a'], edit: true }, USER, newSpan());
  assertEquals(calls[0].p_tags, ['a']);
});

Deno.test('a plain memory.write sends no p_edit and an empty tag list, as before', async () => {
  const { db, calls } = fakeDb({ data: ROW, error: null });
  await toolWrite(db, { scope: 'global', key: 'k', value: 'v' }, USER, newSpan());
  assertEquals('p_edit' in calls[0], false);
  assertEquals(calls[0].p_tags, []);
});
