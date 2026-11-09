/**
 * `PATCH /memories/:id` treats an EXPIRED row as absent, exactly as
 * `GET /memories/:id` does (`get.ts`) and as `memory_write` counts it for
 * `expected_version` (00120): a 404, never an edit and never a 409 naming the
 * dead row's version.
 *
 * `supabase start` is impossible in this sandbox, so the handler runs against a
 * chainable fake `db` holding one row, which evaluates the filters the handler
 * applies (`eq`, `is`, and the `NOT_EXPIRED` `.or()`), so a missing predicate
 * shows up as the wrong status rather than as an assertion on call shape.
 *
 * Run with: deno test --no-check --node-modules-dir=none supabase/functions/memories/handlers/update.expired.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ExportBatch, Span } from '../../_shared/telemetry/otel.ts';
import { NOT_EXPIRED } from '../../_shared/memory/live.ts';
import { handleUpdate } from './update.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

type Row = Record<string, unknown> & { id: string; version: number; expires_at: string | null };

function newSpan(): Span {
  return new Span('lorekit.test', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }, new ExportBatch(), 2);
}

function fakeDb(row: Row) {
  const writes: Record<string, unknown>[] = [];
  function chain(table: string) {
    const preds: ((r: Row) => boolean)[] = [];
    let patch: Record<string, unknown> | null = null;
    // deno-lint-ignore no-explicit-any
    const builder: any = {
      update(p: Record<string, unknown>) { patch = p; return builder; },
      insert(_r: unknown) { return builder; },
      select(..._a: unknown[]) { return builder; },
      eq(col: string, val: unknown) { preds.push((r) => r[col] === val); return builder; },
      is(col: string, val: unknown) { preds.push((r) => (r[col] ?? null) === val); return builder; },
      or(expr: string) {
        if (expr === NOT_EXPIRED) preds.push((r) => r.expires_at === null || Date.parse(r.expires_at) > Date.now());
        return builder;
      },
      maybeSingle() { return builder; },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        if (table !== 'memories') return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        const hit = preds.every((p) => p(row));
        if (hit && patch) { writes.push(patch); Object.assign(row, patch, { version: row.version + 1 }); }
        return Promise.resolve({ data: hit ? { ...row } : null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  // deno-lint-ignore no-explicit-any
  const db: any = { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) };
  return { db, writes };
}

function row(expires_at: string | null): Row {
  return {
    id: ID, user_id: USER, scope: 'global', key: 'k', value: 'old', tags: [], version: 4,
    archived_at: null, expires_at, org_id: null,
  };
}

async function patch(r: Row, body: Record<string, unknown>) {
  const { db, writes } = fakeDb(r);
  const req = new Request(`http://local/memories/${ID}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await handleUpdate(
    req, { type: 'api_key', userId: USER, permissions: ['read', 'write'] }, db, newSpan(), { id: ID }, {},
  );
  return { status: res.status, writes };
}

Deno.test('PATCH on an expired memory is 404 and writes nothing, like GET /:id', async () => {
  const { status, writes } = await patch(row(PAST), { value: 'new' });
  assertEquals(status, 404);
  assertEquals(writes.length, 0);
});

Deno.test('PATCH with expected_version on an expired memory is 404, not a 409 naming its version', async () => {
  const { status, writes } = await patch(row(PAST), { value: 'new', expected_version: 3 });
  assertEquals(status, 404);
  assertEquals(writes.length, 0);
});

Deno.test('PATCH with a stale expected_version on a live memory is still 409', async () => {
  const { status, writes } = await patch(row(FUTURE), { value: 'new', expected_version: 3 });
  assertEquals(status, 409);
  assertEquals(writes.length, 0);
});

Deno.test('PATCH with the current expected_version on a live memory succeeds', async () => {
  const { status, writes } = await patch(row(null), { value: 'new', expected_version: 4 });
  assertEquals(status, 200);
  assertEquals(writes.length, 1);
});
