/**
 * `POST /memories` with `edit: true` (00126): the maintenance edit by
 * scope+key. The handler must send `p_edit` (and NULL tags when the edit omits
 * them, the RPC's "keep the stored tags"), answer the RPC's
 * `memory_not_found` with a 404, and leave a plain write's call unchanged.
 *
 * `supabase start` is impossible in this sandbox, so the handler runs against a
 * fake `db` whose `memory_write` records its arguments and answers with a row
 * or with the error the 00126 migration raises.
 *
 * Run with: deno test --no-check --node-modules-dir=none supabase/functions/memories/handlers/create.edit.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ExportBatch, Span } from '../../_shared/telemetry/otel.ts';
import { handleCreate } from './create.ts';

const ID = '11111111-1111-4111-8111-111111111111';

function newSpan(): Span {
  return new Span('lorekit.test', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }, new ExportBatch(), 2);
}

type RpcAnswer = { data: unknown; error: unknown };

function fakeDb(answer: RpcAnswer) {
  const calls: Record<string, unknown>[] = [];
  // deno-lint-ignore no-explicit-any
  const thenable = (v: unknown): any => {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b, eq: () => b, is: () => b, in: () => b, or: () => b, single: () => b, maybeSingle: () => b,
      insert: () => b, update: () => b, upsert: () => b,
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

async function post(body: Record<string, unknown>, answer: RpcAnswer) {
  const { db, calls } = fakeDb(answer);
  const req = new Request('http://local/memories', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await handleCreate(req, { type: 'service', userId: null, permissions: ['read', 'write'] } as never, db, newSpan(), {}, {});
  return { status: res.status, json: await res.json().catch(() => null), calls };
}

const ROW = {
  id: ID, created_at: '2026-01-01T00:00:00Z', inserted: false, expires_at: null, scope: 'global', key: 'k',
  value: 'v', tags: ['keep'], source_agent: null, trigger: null, updated_at: '2026-01-02T00:00:00Z', archived_at: null,
  origin_repo: null, origin_branch: null, origin_commit: null, origin_pr: null, kind: null, host: null,
  seen_count: 2, attributes: {}, content_type: 'text/markdown', supersedes: null, version: 3,
};
const MISSING = { data: null, error: { code: 'P0002', message: 'memory_not_found: scope=global key=k' } };

Deno.test('POST /memories with edit: true and a missing key is 404 not_found', async () => {
  const { status, json, calls } = await post({ scope: 'global', key: 'k', value: 'v', edit: true }, MISSING);
  assertEquals(status, 404);
  assertEquals(json?.code, 'not_found');
  assertEquals(calls.length, 1);
  assertEquals(calls[0].p_edit, true);
});

Deno.test('POST /memories with edit: true sends p_edit and NULL tags when tags are omitted', async () => {
  const { status, json, calls } = await post({ scope: 'global', key: 'k', value: 'v', edit: true }, { data: ROW, error: null });
  assertEquals(status, 201);
  assertEquals(calls[0].p_edit, true);
  assertEquals(calls[0].p_tags, null);
  assertEquals(json?.seen_count, 2);
  assertEquals(json?.edit, true);
});

Deno.test('POST /memories with edit: true and tags sends those tags', async () => {
  const { calls } = await post({ scope: 'global', key: 'k', value: 'v', tags: ['a'], edit: true }, { data: ROW, error: null });
  assertEquals(calls[0].p_tags, ['a']);
});

Deno.test('a plain POST /memories sends no p_edit and an empty tag list, as before', async () => {
  const { status, json, calls } = await post({ scope: 'global', key: 'k', value: 'v' }, { data: ROW, error: null });
  assertEquals(status, 201);
  assertEquals('p_edit' in calls[0], false);
  assertEquals(json?.edit, undefined);
  assertEquals(calls[0].p_tags, []);
});

Deno.test('POST /memories rejects a non-boolean edit with 400', async () => {
  const { status, calls } = await post({ scope: 'global', key: 'k', value: 'v', edit: 'yes' }, { data: ROW, error: null });
  assertEquals(status, 400);
  assertEquals(calls.length, 0);
});
