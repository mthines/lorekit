/**
 * `getUserPlanName` memoises per request span — `supabase/functions/_shared/telemetry/usage.ts`.
 *
 * The MCP transport resolves the plan in `mcp/index.ts` and then again inside
 * `tools/call` (`mcp/mcp-handler.ts`), for the same user in the same request.
 * Each caller builds its own db client (`getDb` returns a new one per call), so
 * the memo is keyed on the request's root span instead: same span + same user
 * means one `user_plans` query. A call with no span (the REST router) is never
 * memoised.
 *
 * `supabase start` is impossible in this sandbox, so the db is a hand-rolled
 * chainable fake that counts `from('user_plans')` calls — the one call both the
 * traced and the untraced path make per query.
 *
 * Not run by CI (the edge tree has no Deno test job). Run with:
 *   NODE_USE_ENV_PROXY=1 deno test --no-check --node-modules-dir=none supabase/functions/_shared/telemetry/usage.plan-memo.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ExportBatch, Span } from './otel.ts';
import { getUserPlanName } from './usage.ts';
import type { DbClient } from '../db/db-client.ts';

function newRootSpan(): Span {
  return new Span(
    'lorekit.test',
    { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true },
    new ExportBatch(),
    2, // SPAN_KIND_SERVER
  );
}

/** A fake db whose `user_plans` lookup resolves to `planName`, or throws when `fail`. */
function fakeDb(counter: { queries: number }, planName: string, fail = false): DbClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => builder,
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      (fail
        ? Promise.reject(new Error('connection reset'))
        : Promise.resolve({ data: { plan_name: planName }, error: null })
      ).then(onFulfilled, onRejected),
  };
  return {
    from: (table: string) => {
      if (table === 'user_plans') counter.queries++;
      return builder;
    },
  } as unknown as DbClient;
}

Deno.test('same span + same user across two db clients issues ONE query', async () => {
  const counter = { queries: 0 };
  const span = newRootSpan();
  const first = await getUserPlanName(fakeDb(counter, 'pro'), 'u1', span);
  const second = await getUserPlanName(fakeDb(counter, 'pro'), 'u1', span);
  assertEquals([first, second], ['pro', 'pro']);
  assertEquals(counter.queries, 1);
});

Deno.test('concurrent calls on the same span share one in-flight query', async () => {
  const counter = { queries: 0 };
  const span = newRootSpan();
  const results = await Promise.all([
    getUserPlanName(fakeDb(counter, 'pro'), 'u1', span),
    getUserPlanName(fakeDb(counter, 'pro'), 'u1', span),
  ]);
  assertEquals(results, ['pro', 'pro']);
  assertEquals(counter.queries, 1);
});

Deno.test('a different span issues its own query', async () => {
  const counter = { queries: 0 };
  await getUserPlanName(fakeDb(counter, 'pro'), 'u1', newRootSpan());
  await getUserPlanName(fakeDb(counter, 'pro'), 'u1', newRootSpan());
  assertEquals(counter.queries, 2);
});

Deno.test('a different user on the same span issues its own query', async () => {
  const counter = { queries: 0 };
  const span = newRootSpan();
  const a = await getUserPlanName(fakeDb(counter, 'pro'), 'u1', span);
  const b = await getUserPlanName(fakeDb(counter, 'team'), 'u2', span);
  assertEquals([a, b], ['pro', 'team']);
  assertEquals(counter.queries, 2);
});

Deno.test('no span means no memo: every call queries', async () => {
  const counter = { queries: 0 };
  const db = fakeDb(counter, 'pro');
  await getUserPlanName(db, 'u1');
  await getUserPlanName(db, 'u1');
  assertEquals(counter.queries, 2);
});

Deno.test('a failed lookup (null) is not memoised: the next call retries', async () => {
  const counter = { queries: 0 };
  const span = newRootSpan();
  const failed = await getUserPlanName(fakeDb(counter, 'pro', true), 'u1', span);
  const retried = await getUserPlanName(fakeDb(counter, 'pro'), 'u1', span);
  assertEquals([failed, retried], [null, 'pro']);
  assertEquals(counter.queries, 2);
});

Deno.test('a missing row still resolves to free and is memoised', async () => {
  const counter = { queries: 0 };
  const span = newRootSpan();
  const db = {
    from: () => {
      counter.queries++;
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => b,
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(f, r),
      };
      return b;
    },
  } as unknown as DbClient;
  assertEquals(await getUserPlanName(db, 'u1', span), 'free');
  assertEquals(await getUserPlanName(db, 'u1', span), 'free');
  assertEquals(counter.queries, 1);
});
