/**
 * Repro + regression test for the "Elevated error count" false positive
 * (Dash0 check rule bb2e9fc6-916a-4039-aa75-209b50ecac57, issue
 * 14554528595661769145): `DELETE /memories?scope=…&key=…&org=lorekit-smoke-nonexistent`
 * is a well-known, tested, expected 404 ("unknown_org" raised by the
 * `memory_delete` RPC — see `memories/handlers/remove.ts`'s `removeOrgOwned`
 * and `packages/smoke-tests/src/memories-api.integration.spec.ts`'s
 * "never 400s and never 405s" comment), yet `TracedQuery.then()` unconditionally
 * marked the underlying DB span status=ERROR for ANY Postgrest error other than
 * `PGRST116`, inflating the API's span-error-rate alert with requests it was
 * handling correctly.
 *
 * Run with: deno test --no-check supabase/functions/_shared/otel.error-classification.test.ts
 * (--no-check because the surrounding tree needs the full Supabase import-map
 * to typecheck; `node scripts/ci/deno-check-functions.mjs` is the typecheck gate).
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { createTracedClient, ExportBatch, Span, type TracedSupabaseClient } from './otel.ts';

function newRootSpan(): { span: Span; batch: ExportBatch } {
  const batch = new ExportBatch();
  const span = new Span(
    'lorekit.test',
    { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true },
    batch,
    2, // SPAN_KIND_SERVER
  );
  return { span, batch };
}

function fakeSupabaseRpc(result: { data: unknown; error: unknown }) {
  return {
    rpc: () => ({ single: () => Promise.resolve(result) }),
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test('memory_delete unknown_org (expected 404) does NOT mark the DB span ERROR', async () => {
  const { span, batch } = newRootSpan();
  const db: TracedSupabaseClient = createTracedClient(
    fakeSupabaseRpc({
      data: null,
      error: { message: 'PostgrestError: unknown_org: lorekit-smoke-nonexistent', code: 'P0001' },
    }),
    span,
  );

  // deno-lint-ignore no-explicit-any
  await (db as any).rpc('memory_delete', {}).single();

  const spans = batch.drain();
  const dbSpan = spans.find((s) => s.name.startsWith('CALL memory_delete'));
  if (!dbSpan) throw new Error('expected a CALL memory_delete(...) span to have been recorded');
  assertEquals(dbSpan.status, 'ok', 'unknown_org is a caller-addressable 404, not a server fault');
  assertEquals(
    dbSpan.attributes['error.message'],
    'PostgrestError: PostgrestError: unknown_org: lorekit-smoke-nonexistent',
  );
});

Deno.test('memory_delete LK002 (org permission denied, mapped 403) does NOT mark the DB span ERROR', async () => {
  const { span, batch } = newRootSpan();
  const db: TracedSupabaseClient = createTracedClient(
    fakeSupabaseRpc({ data: null, error: { message: 'permission denied', code: 'LK002' } }),
    span,
  );

  // deno-lint-ignore no-explicit-any
  await (db as any).rpc('memory_delete', {}).single();

  const dbSpan = batch.drain().find((s) => s.name.startsWith('CALL memory_delete'));
  if (!dbSpan) throw new Error('expected a CALL memory_delete(...) span to have been recorded');
  assertEquals(dbSpan.status, 'ok');
});

Deno.test('an unclassified Postgrest error still marks the DB span ERROR (no over-suppression)', async () => {
  const { span, batch } = newRootSpan();
  const db: TracedSupabaseClient = createTracedClient(
    fakeSupabaseRpc({ data: null, error: { message: 'connection terminated unexpectedly', code: '08006' } }),
    span,
  );

  // deno-lint-ignore no-explicit-any
  await (db as any).rpc('memory_delete', {}).single();

  const dbSpan = batch.drain().find((s) => s.name.startsWith('CALL memory_delete'));
  if (!dbSpan) throw new Error('expected a CALL memory_delete(...) span to have been recorded');
  assertEquals(dbSpan.status, 'error', 'a genuine server-side fault must still mark the span ERROR');
});

Deno.test('.single() no-rows (PGRST116) keeps its existing "not an error" treatment', async () => {
  const { span, batch } = newRootSpan();
  const db: TracedSupabaseClient = createTracedClient(
    fakeSupabaseRpc({ data: null, error: { message: 'no rows', code: 'PGRST116' } }),
    span,
  );

  // deno-lint-ignore no-explicit-any
  await (db as any).rpc('memory_delete', {}).single();

  const dbSpan = batch.drain().find((s) => s.name.startsWith('CALL memory_delete'));
  if (!dbSpan) throw new Error('expected a CALL memory_delete(...) span to have been recorded');
  assertEquals(dbSpan.status, 'ok');
  assertEquals(dbSpan.attributes['db.no_rows'], true);
});
