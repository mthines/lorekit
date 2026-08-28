/**
 * Repro + regression test for a second false-positive source on the
 * "Elevated error count" check (Dash0 check rule
 * bb2e9fc6-916a-4039-aa75-209b50ecac57, `service.name=api`,
 * `service.namespace=lorekit`) — distinct from the `unknown_org` cause fixed
 * in `otel.error-classification.test.ts` and PR #582's migration-collision
 * cause. Here, PostgREST rejects the user's JWT with "JWT issued at future"
 * on `CALL lorekit_memory_scopes(...)` / `CALL lorekit_memory_list(...)`
 * (transient clock skew between GoTrue, which issues the token, and
 * PostgREST, which independently re-verifies it) — a caller-side condition
 * that `translateDbError` did not recognise, so it fell through to
 * `internalError` (500) instead of a 401.
 *
 * Run with: deno test --no-check supabase/functions/_shared/api/errors.jwt-clock-skew.test.ts
 * (--no-check because the surrounding tree needs the full Supabase import-map
 * to typecheck; `node scripts/ci/deno-check-functions.mjs` is the typecheck gate).
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { translateDbError } from './errors.ts';
import { createTracedClient, ExportBatch, Span, type TracedSupabaseClient } from '../telemetry/otel.ts';

Deno.test('translateDbError maps PostgREST "JWT issued at future" to a 401, not null', () => {
  const mapped = translateDbError({ message: 'JWT issued at future' });
  if (!mapped) throw new Error('expected translateDbError to recognise the PostgREST JWT error');
  assertEquals(mapped.status, 401);
  assertEquals(mapped.code, 'invalid_jwt');
});

Deno.test('translateDbError maps sibling PostgREST JWT errors (expired / not yet valid / invalid) to 401', () => {
  for (const message of ['JWT expired', 'JWT not yet valid', 'JWT invalid']) {
    const mapped = translateDbError({ message });
    if (!mapped) throw new Error(`expected translateDbError to recognise "${message}"`);
    assertEquals(mapped.status, 401, message);
    assertEquals(mapped.code, 'invalid_jwt', message);
  }
});

Deno.test('translateDbError does not misfire on an unrelated message containing "jwt"', () => {
  const mapped = translateDbError({ message: 'column "jwt_token" does not exist' });
  assertEquals(mapped, null);
});

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

Deno.test('CALL lorekit_memory_scopes(...) with a JWT clock-skew error does NOT mark the DB span ERROR', async () => {
  const { span, batch } = newRootSpan();
  const db: TracedSupabaseClient = createTracedClient(
    fakeSupabaseRpc({ data: null, error: { message: 'JWT issued at future' } }),
    span,
  );

  // deno-lint-ignore no-explicit-any
  await (db as any).rpc('lorekit_memory_scopes', {}).single();

  const spans = batch.drain();
  const dbSpan = spans.find((s) => s.name.startsWith('CALL lorekit_memory_scopes'));
  if (!dbSpan) throw new Error('expected a CALL lorekit_memory_scopes(...) span to have been recorded');
  assertEquals(dbSpan.status, 'ok', 'a JWT clock-skew rejection is caller-addressable, not a server fault');
});
