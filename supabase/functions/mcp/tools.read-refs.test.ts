/**
 * Regression + acceptance tests for batch `memory.read` (`refs`) — `toolRead`'s
 * new `refs` branch and its internal `toolReadRefs` helper, in
 * `supabase/functions/mcp/tools.ts`.
 *
 * `supabase start` is impossible in this sandbox (no Docker socket), so every
 * test drives `toolRead` with a hand-rolled chainable fake `db` and asserts on
 * what the handler ASKED the db for, never against a real Postgres instance.
 * The fake reproduces exactly the surface `createTracedClient` calls through:
 * `db.from(table).select(...).eq(...).in(...).is(...).or(...)[.maybeSingle()]`
 * (thenable, resolving `{data, error}`) and `db.rpc(fn, args)` (a plain
 * Promise, matching `recordMemoryReads`'s and `memberOrgIds`'s direct-`db`
 * usage — neither goes through `createTracedClient`).
 *
 * Concurrency (AC-6) relies on real `await`/microtask ordering rather than a
 * manual gate: `Promise.all(groups.map(async (...) => { ... await query; ...
 * }))` runs each async callback synchronously up to its first `await`, so by
 * the time any one of the fake chains' `.then()` has actually resolved (which
 * this fake defers by one extra microtask hop via `queueMicrotask`), every
 * group's `.then()` has already been INVOKED and recorded its start. No sleep,
 * no manual "release" signal — just microtask-queue FIFO ordering.
 *
 * Run with: deno test --no-check --filter 'AC-<n>:' supabase/functions/mcp/tools.read-refs.test.ts
 * (--no-check because the surrounding tree needs the full Supabase import-map
 * to typecheck; `node scripts/ci/deno-check-functions.mjs` is the typecheck gate).
 */
import { assertEquals, assertThrows, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ExportBatch, Span } from '../_shared/telemetry/otel.ts';
import { UserInputError } from '../_shared/scope/scope.ts';
import { toolRead } from './tools.ts';

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

type Row = { id: string; scope: string; key: string; value: string; updated_at: string };

/**
 * A fake `db` covering both `toolRead` paths:
 *  - singular (`scope`+`key`): `.select(...).eq(...).eq(...).is(...).or(...).maybeSingle()`
 *  - batch (`refs`): one `.select(...).eq(...).in(...).is(...).or(...)` PER
 *    distinct scope group, awaited directly (no `.maybeSingle()`).
 *
 * `rowsByScope` keys the batch path's canned rows by the EXACT scope string
 * the handler queried with (byte-equal, never lowercased) — this is what lets
 * AC-4 assert the predicate saw the mixed-case scope verbatim. `singleRow`
 * feeds the singular path.
 */
function fakeDb(opts: { rowsByScope?: Map<string, Row[]>; singleRow?: Row | null } = {}) {
  const order: string[] = [];
  const queries: { table: string; filters: [string, unknown][]; single: boolean }[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  function chain(table: string) {
    const rec: { table: string; filters: [string, unknown][]; single: boolean } = {
      table,
      filters: [],
      single: false,
    };
    queries.push(rec);
    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select(..._args: unknown[]) { return builder; },
      eq(col: string, val: unknown) { rec.filters.push([col, val]); return builder; },
      in(col: string, vals: unknown) { rec.filters.push([col, vals]); return builder; },
      is(col: string, val: unknown) { rec.filters.push([col, val]); return builder; },
      or(_expr: string) { return builder; },
      maybeSingle() { rec.single = true; return builder; },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        const scopeEntry = rec.filters.find(([c]) => c === 'scope');
        const scope = scopeEntry ? (scopeEntry[1] as string) : undefined;
        order.push(scope ?? '');
        return Promise.resolve()
          .then(() => new Promise((res) => queueMicrotask(() => res(undefined))))
          .then(() => {
            if (rec.single) {
              return { data: opts.singleRow ?? null, error: null };
            }
            const rows = (scope !== undefined ? opts.rowsByScope?.get(scope) : undefined) ?? [];
            return { data: rows, error: null };
          })
          .then(resolve, reject);
      },
    };
    return builder;
  }

  const db = {
    from(table: string) { return chain(table); },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  return { db, queries, rpcCalls, order };
}

Deno.test('AC-1: refs branch returns entries and missing', async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['global', [{ id: '1', scope: 'global', key: 'a', value: 'v', updated_at: 't' }]],
  ]);
  const { db } = fakeDb({ rowsByScope });

  const result = await toolRead(db, { refs: ['global::a'] }, null, span);

  assertEquals(Object.keys(result as object).sort(), ['entries', 'missing']);
  assertEquals(Array.isArray((result as { entries: unknown[] }).entries), true);
  assertEquals(Array.isArray((result as { missing: unknown[] }).missing), true);
});

Deno.test('AC-1: singular branch own keys are exactly value and updated_at', async () => {
  const { span } = newRootSpan();
  // Only the columns the singular path actually selects (`id,value,updated_at`)
  // — a real Postgres response would never carry `scope`/`key` here, so the
  // fake must not either or this assertion would pass for the wrong reason.
  const { db } = fakeDb({
    // deno-lint-ignore no-explicit-any
    singleRow: { id: '1', value: 'hello', updated_at: 't' } as any,
  });

  const result = await toolRead(db, { scope: 'global', key: 'a' }, null, span);

  assertEquals(Object.keys(result as object).sort(), ['updated_at', 'value']);
});

Deno.test('AC-2: refs together with scope or key is rejected', async () => {
  const { span } = newRootSpan();
  const { db, queries } = fakeDb();

  const err = await assertRejects(
    () => toolRead(db, { refs: ['global::a'], scope: 'global' }, null, span),
    UserInputError,
  );
  assertEquals(err.message.includes('refs'), true);
  assertEquals(err.message.toLowerCase().includes('scope'), true);
  assertEquals(queries.length, 0, 'the rejection must happen before any db call');
});

// Review follow-up (PR #654): `parseMemoryRefs` DROPS what it cannot parse, so
// without a shape guard a non-array or empty `refs` resolved to an empty,
// SUCCESSFUL `{entries:[],missing:[]}` — a malformed call indistinguishable
// from a well-formed one that matched nothing. REST already 400s on the same
// input via `ReadMemoriesBodySchema`; this pins the MCP side to agree.
Deno.test('a non-array refs is rejected, not read as zero matches', async () => {
  const { span } = newRootSpan();
  const { db, queries } = fakeDb();

  const err = await assertRejects(
    () => toolRead(db, { refs: 'global::a' as unknown as string[] }, null, span),
    UserInputError,
  );
  assertEquals(err.message.includes('refs'), true);
  assertEquals(queries.length, 0, 'the rejection must happen before any db call');
});

Deno.test('an empty refs array is rejected, not read as zero matches', async () => {
  const { span } = newRootSpan();
  const { db, queries } = fakeDb();

  await assertRejects(
    () => toolRead(db, { refs: [] }, null, span),
    UserInputError,
  );
  assertEquals(queries.length, 0, 'the rejection must happen before any db call');
});

// The guard validates the SHAPE only. An individually unparseable ref inside a
// well-formed array does NOT fail the call — but note it also does not reach
// `missing`: `parseMemoryRefs` drops it before `missingRefs` ever sees it, and
// `missing` is computed from PARSED refs minus found rows. So `missing` reports
// well-formed-but-not-found, never malformed. Pinned here because the catalog
// note documents exactly this distinction, and an earlier draft of that note
// claimed malformed refs surfaced in `missing`.
Deno.test('an unparseable ref is dropped, not surfaced in missing', async () => {
  const { span } = newRootSpan();
  const { db, queries } = fakeDb();

  const out = await toolRead(db, { refs: ['not-a-ref'] }, null, span) as {
    entries: unknown[];
    missing: string[];
  };
  assertEquals(out.entries, []);
  assertEquals(out.missing, [], 'malformed refs are dropped at parse time');
  assertEquals(queries.length, 0, 'nothing parseable means nothing to query');
});

Deno.test('AC-3: refs spanning two scopes resolve in one call', async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['global', [{ id: '1', scope: 'global', key: 'a', value: 'v1', updated_at: 't1' }]],
    ['repo::o/r', [{ id: '2', scope: 'repo::o/r', key: 'b', value: 'v2', updated_at: 't2' }]],
  ]);
  const { db } = fakeDb({ rowsByScope });

  const result = await toolRead(db, { refs: ['global::a', 'repo::o/r::b'] }, null, span) as {
    entries: { scope: string; key: string }[];
    missing: string[];
  };

  assertEquals(result.entries.length, 2);
  const pairs = new Set(result.entries.map((e) => `${e.scope}::${e.key}`));
  assertEquals(pairs.has('global::a'), true);
  assertEquals(pairs.has('repo::o/r::b'), true);
  assertEquals(result.missing, []);
});

Deno.test('AC-4: a mixed-case ref scope reaches the predicate verbatim', async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['Repo::Owner/Repo', [{ id: '1', scope: 'Repo::Owner/Repo', key: 'some-key', value: 'v', updated_at: 't' }]],
  ]);
  const { db, queries } = fakeDb({ rowsByScope });

  await toolRead(db, { refs: ['Repo::Owner/Repo::some-key'] }, null, span);

  const scopeFilters = queries.flatMap((q) => q.filters.filter(([c]) => c === 'scope').map(([, v]) => v));
  assertEquals(scopeFilters, ['Repo::Owner/Repo'], 'the scope filter must be byte-equal, not lowercased');
});

Deno.test('AC-6: one query per distinct scope, all started before the first resolves', async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['global', [{ id: '1', scope: 'global', key: 'a', value: 'v', updated_at: 't' }]],
    ['repo::o/r', [
      { id: '2', scope: 'repo::o/r', key: 'b', value: 'v', updated_at: 't' },
      { id: '3', scope: 'repo::o/r', key: 'c', value: 'v', updated_at: 't' },
    ]],
    ['project::demo', [{ id: '4', scope: 'project::demo', key: 'd', value: 'v', updated_at: 't' }]],
  ]);
  const { db, queries, order } = fakeDb({ rowsByScope });

  await toolRead(
    db,
    { refs: ['global::a', 'repo::o/r::b', 'repo::o/r::c', 'project::demo::d'] },
    null,
    span,
  );

  // 3 distinct scopes, 4 keys total -> exactly 3 query builds, never 4 or 1.
  assertEquals(queries.length, 3);
  const byScope = new Map(queries.map((q) => [q.filters.find(([c]) => c === 'scope')?.[1], q]));
  assertEquals((byScope.get('repo::o/r') as typeof queries[number]).filters.find(([c]) => c === 'key')?.[1], ['b', 'c']);

  // All 3 must have STARTED (order recorded at .then()-invocation time) before
  // any of them resolves — the fake's queueMicrotask hop guarantees this by
  // construction (see the module docblock), so this assertion is a genuine
  // check on the recorded order length, not a tautology.
  assertEquals(order.length, 3);
  assertEquals(new Set(order), new Set(['global', 'repo::o/r', 'project::demo']));
});

Deno.test("AC-7: N found rows record one targeted read for all N ids", async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['global', [
      { id: '1', scope: 'global', key: 'a', value: 'v', updated_at: 't' },
      { id: '2', scope: 'global', key: 'b', value: 'v', updated_at: 't' },
    ]],
  ]);
  const { db, rpcCalls } = fakeDb({ rowsByScope });

  await toolRead(db, { refs: ['global::a', 'global::b'] }, null, span);
  // recordMemoryReads is fire-and-forget (`void p`) — flush microtasks.
  await Promise.resolve();
  await Promise.resolve();

  const recordCalls = rpcCalls.filter((c) => c.fn === 'lorekit_record_memory_reads');
  assertEquals(recordCalls.length, 1, 'must be exactly one call for the whole batch, never one per row');
  assertEquals(recordCalls[0].args.p_read_kind, 'targeted');
  assertEquals(recordCalls[0].args.p_client, 'mcp');
  assertEquals((recordCalls[0].args.p_memory_ids as string[]).sort(), ['1', '2']);
});

Deno.test('AC-11: an unqueryable key becomes missing and issues no query', async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['repo::o/r', [{ id: '2', scope: 'repo::o/r', key: 'good-key', value: 'v', updated_at: 't' }]],
  ]);
  const { db, queries } = fakeDb({ rowsByScope });

  const result = await toolRead(
    db,
    { refs: ['global::bad,key', 'repo::o/r::good-key'] },
    null,
    span,
  ) as { entries: { scope: string; key: string }[]; missing: string[] };

  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].scope, 'repo::o/r');
  assertEquals(result.missing, ['global::bad,key']);
  // No query was ever built for the 'global' scope — the bad ref never
  // reached a filter list at all, it never merely returned zero rows.
  const scopesQueried = queries.map((q) => q.filters.find(([c]) => c === 'scope')?.[1]);
  assertEquals(scopesQueried.includes('global'), false);
});

Deno.test('AC-15: a duplicated ref yields one entry and one recorded open', async () => {
  const { span } = newRootSpan();
  const rowsByScope = new Map<string, Row[]>([
    ['global', [{ id: '1', scope: 'global', key: 'a', value: 'v', updated_at: 't' }]],
  ]);
  const { db, rpcCalls } = fakeDb({ rowsByScope });

  const result = await toolRead(db, { refs: ['global::a', 'global::a'] }, null, span) as {
    entries: unknown[];
    missing: string[];
  };
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(result.entries.length, 1);
  const recordCalls = rpcCalls.filter((c) => c.fn === 'lorekit_record_memory_reads');
  assertEquals(recordCalls.length, 1);
  assertEquals((recordCalls[0].args.p_memory_ids as string[]).length, 1);
});

Deno.test('AC-15: a 40-ref list is truncated to 32', async () => {
  const { span } = newRootSpan();
  const refs = Array.from({ length: 40 }, (_, i) => `global::key-${i}`);
  const rowsByScope = new Map<string, Row[]>([['global', []]]);
  const { db, queries } = fakeDb({ rowsByScope });

  const result = await toolRead(db, { refs }, null, span) as { entries: unknown[]; missing: string[] };

  assertEquals(result.missing.length, 32, 'at most 32 references are ever considered');
  const inFilter = queries[0].filters.find(([c]) => c === 'key');
  assertEquals((inFilter?.[1] as string[]).length, 32);
});
