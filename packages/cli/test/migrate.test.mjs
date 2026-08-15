// `lorekit migrate` — dry-run/apply/idempotency and scope routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';
import { createLocalStore } from '../src/store/local.mjs';
import { setWriters } from '../src/util.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-mig-'));
}

// Silence migrate's output for the duration of `fn`.
//
// Redirects the CLI's own writers rather than hijacking `process.stdout.write`.
// That distinction is load-bearing: `node --test` runs this file in a child
// process and reports results over stdout, so a global hijack swallows the
// runner's result lines — the suite then reports a fraction of its tests and a
// failure can disappear entirely.
async function quiet(fn) {
  const restore = setWriters({ out: () => {}, err: () => {} });
  try {
    return await fn();
  } finally {
    restore();
  }
}

// Seed a source store with two entries across two scopes.
function seedSource() {
  const src = tmpDir();
  const s = createLocalStore(src);
  return Promise.all([
    s.write({ scope: 'global', key: 'g1', value: 'gv', tags: ['x'] }),
    s.write({ scope: 'repo::o/r', key: 'r1', value: 'rv', tags: ['y'] }),
  ]).then(() => src);
}

function withHome(home, fn) {
  const prev = process.env.LOREKIT_HOME;
  const prevStore = process.env.LOREKIT_STORE;
  process.env.LOREKIT_HOME = home;
  delete process.env.LOREKIT_STORE;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.LOREKIT_HOME;
      else process.env.LOREKIT_HOME = prev;
      if (prevStore === undefined) delete process.env.LOREKIT_STORE;
      else process.env.LOREKIT_STORE = prevStore;
    });
}

test('migrate --to home: dry-run writes nothing, --yes applies, re-run is idempotent', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    // Dry-run: no writes.
    await quiet(() => migrate({ from: src, to: 'home', dir: root }));
    assert.equal(createLocalStore(home).getEntry({ scope: 'global', key: 'g1' }), null);

    // Apply.
    await quiet(() => migrate({ from: src, to: 'home', apply: true, dir: root }));
    const dest = createLocalStore(home);
    assert.equal(dest.getEntry({ scope: 'global', key: 'g1' }).value, 'gv');
    assert.equal(dest.getEntry({ scope: 'repo::o/r', key: 'r1' }).value, 'rv');

    // Idempotent: a second apply leaves the entries byte-identical.
    const before = dest.getEntry({ scope: 'global', key: 'g1' });
    await quiet(() => migrate({ from: src, to: 'home', apply: true, dir: root }));
    const after = createLocalStore(home).getEntry({ scope: 'global', key: 'g1' });
    assert.deepEqual(after, before);
    assert.equal((await createLocalStore(home).list({ scope: 'global' })).entries.length, 1);
  });
});

test('migrate default routing: global→home; repo→home when project not opted-in', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir(); // no .lorekit/ under root → project tier not opted-in

  await withHome(home, async () => {
    await quiet(() => migrate({ from: src, apply: true, dir: root }));
    const dest = createLocalStore(home);
    assert.equal(dest.getEntry({ scope: 'global', key: 'g1' }).value, 'gv');
    assert.equal(dest.getEntry({ scope: 'repo::o/r', key: 'r1' }).value, 'rv');
    // Nothing landed in a project dir (it does not exist).
    assert.equal(fs.existsSync(path.join(root, '.lorekit')), false);
  });
});

test('migrate --to project creates the opted-in project dir on apply', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    await quiet(() => migrate({ from: src, to: 'project', apply: true, dir: root }));
    const proj = createLocalStore(path.join(root, '.lorekit'));
    assert.equal(proj.getEntry({ scope: 'repo::o/r', key: 'r1' }).value, 'rv');
    assert.equal(proj.getEntry({ scope: 'global', key: 'g1' }).value, 'gv');
  });
});

test('migrate errors when --from is missing or does not exist', async () => {
  const home = tmpDir();
  await withHome(home, async () => {
    assert.equal(await quiet(() => migrate({ dir: tmpDir() })), 1);
    assert.equal(await quiet(() => migrate({ from: '/no/such/store', dir: tmpDir() })), 1);
  });
});

// ── `migrate --to remote` ───────────────────────────────────────────────────
//
// The destination is a real `RemoteStore` over a stubbed `fetch`, not a hand-
// written store double: the contract under test is what goes ON THE WIRE
// (created_at preserved, no seen_count, a re-run issuing no writes), and a
// double would let the store and the assertion drift together.

const REMOTE_URL = 'https://ref.supabase.co/functions/v1/mcp';

// Run `fn` with a stubbed fetch and a configured remote connection, capturing
// every request. `respond({ method, url, body })` returns `{ status, body }`;
// the default answers "no such memory" to reads and 201 to writes.
async function withRemote(fn, { respond = null, token = 'lk_rw_test' } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const prevUrl = process.env.LOREKIT_MCP_URL;
  const prevToken = process.env.LOREKIT_TOKEN;
  if (token === null) delete process.env.LOREKIT_TOKEN;
  else process.env.LOREKIT_TOKEN = token;
  process.env.LOREKIT_MCP_URL = REMOTE_URL;

  globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const answer = (respond && respond(call, calls)) || null;
    const status = answer?.status ?? (call.method === 'POST' ? 201 : 200);
    const body = answer?.body ?? (call.method === 'POST' ? '{}' : JSON.stringify({ entries: [] }));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Mock',
      headers: { get: (h) => (answer?.headers ?? {})[String(h).toLowerCase()] ?? null },
      async text() { return body; },
    };
  };

  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = originalFetch;
    if (prevUrl === undefined) delete process.env.LOREKIT_MCP_URL;
    else process.env.LOREKIT_MCP_URL = prevUrl;
    if (prevToken === undefined) delete process.env.LOREKIT_TOKEN;
    else process.env.LOREKIT_TOKEN = prevToken;
  }
}

const writes = (calls) => calls.filter((c) => c.method === 'POST');

// Capture migrate's output instead of discarding it, for the reports whose
// whole job is to tell the user what happened. Same seam as `quiet`, and for
// the same reason.
async function captured(fn) {
  let text = '';
  const collect = (s) => { text += s; };
  const restore = setWriters({ out: collect, err: collect });
  try {
    const result = await fn();
    return { result, text };
  } finally {
    restore();
  }
}

// A remote store with no `--yes` never writes; the plan is reads only.
test('migrate --to remote: dry-run reads a plan and writes nothing', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(() =>
      quiet(() => migrate({ from: src, to: 'remote', dir: root })));
    assert.equal(result, 0);
    assert.equal(writes(calls).length, 0);
    assert.equal(calls.length, 2); // one classifying read per entry
    assert.match(calls[0].url, /\/memories\?scope=/);
  });
});

test('migrate --to remote --yes pushes every entry, preserving created and never seen_count', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(() =>
      quiet(() => migrate({ from: src, to: 'remote', yes: true, dir: root })));
    assert.equal(result, 0);

    const posts = writes(calls);
    assert.equal(posts.length, 2);
    const byKey = Object.fromEntries(posts.map((p) => [p.body.key, p.body]));
    assert.equal(byKey.g1.scope, 'global');
    assert.equal(byKey.g1.value, 'gv');
    assert.deepEqual(byKey.g1.tags, ['x']);
    assert.equal(byKey.r1.scope, 'repo::o/r');
    // The fidelity contract: the original creation date travels, the two
    // server-owned fields do not.
    assert.match(byKey.g1.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal('seen_count' in byKey.g1, false);
    assert.equal('updated' in byKey.g1, false);
  });
});

test('migrate --to remote is idempotent: a store that already matches is all-noop', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    // The hosted store answers every read with the same content, in the REST
    // row shape (created_at/updated_at) — deliberately different timestamps
    // than the source, because those are server-owned and must not count as a
    // difference. Only the writable fields decide.
    const remoteRow = (scope, key) => ({
      id: '00000000-0000-0000-0000-000000000000',
      scope, key,
      value: key === 'g1' ? 'gv' : 'rv',
      tags: key === 'g1' ? ['x'] : ['y'],
      source_agent: null, trigger: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      expires_at: null, archived_at: null,
      seen_count: 42,
    });
    const { result, calls } = await withRemote(
      () => quiet(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      {
        respond: (call) => {
          if (call.method !== 'GET') return null;
          const p = new URL(call.url).searchParams;
          return { status: 200, body: JSON.stringify({ entries: [remoteRow(p.get('scope'), p.get('key'))] }) };
        },
      },
    );
    assert.equal(result, 0);
    assert.equal(writes(calls).length, 0);
  });
});

test('migrate --to remote fails the preflight with no configured connection', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      { token: null },
    );
    assert.equal(result.result, 1);
    assert.match(result.text, /no usable remote connection/);
    assert.equal(calls.length, 0); // fails before the first request, not mid-run
  });
});

test('migrate --to remote rejects a read-only token before writing anything', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      { token: 'lk_ro_readonly' },
    );
    assert.equal(result.result, 1);
    assert.match(result.text, /read-only/);
    assert.equal(calls.length, 0);
  });
});

test('migrate --to remote survives a 429 by honouring Retry-After', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();
  const slept = [];

  await withHome(home, async () => {
    let limited = 0;
    const { result, calls } = await withRemote(
      () => quiet(() => migrate(
        { from: src, to: 'remote', yes: true, dir: root },
        { sleepFn: async (ms) => { slept.push(ms); } },
      )),
      {
        respond: (call) => {
          // Rate-limit the first write only; the retry must then succeed.
          if (call.method === 'POST' && limited++ === 0) {
            return {
              status: 429,
              body: JSON.stringify({ error: 'Too many requests', code: 'rate_limited', retryAfterSeconds: 2 }),
              headers: { 'retry-after': '2' },
            };
          }
          return null;
        },
      },
    );
    assert.equal(result, 0);
    // Three writes issued for two entries: the rejected one, its retry, and
    // the second entry — so the 429 cost a retry, not the migration.
    assert.equal(writes(calls).length, 3);
    assert.deepEqual(slept, [2000]); // the server's own hint, not a guess
  });
});

test('migrate --to remote reports partial progress and exits non-zero on the memory cap', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    let posts = 0;
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      {
        respond: (call) => {
          if (call.method !== 'POST') return null;
          // The first write lands, the second hits the cap. The cap is
          // translated to a 429 too, so only `code` tells it apart from a
          // rate limit — and it must NOT be retried.
          if (posts++ === 0) return null;
          return {
            status: 429,
            body: JSON.stringify({ error: 'Memory limit exceeded. Archive unused memories or upgrade your plan.', code: 'memory_cap' }),
          };
        },
      },
    );
    assert.equal(result.result, 1);
    assert.match(result.text, /Memory limit exceeded/);
    assert.match(result.text, /1 entry migrated before the cap was reached/);
    assert.equal(writes(calls).length, 2); // no retry storm against a terminal error
  });
});

test('migrate --to remote skips archived and expired entries instead of reviving them', async () => {
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'live', value: 'v' });
  await store.write({ scope: 'global', key: 'gone', value: 'v' });
  await store.archive({ scope: 'global', key: 'gone' });
  await store.write({ scope: 'global', key: 'stale', value: 'v', ttl_days: 1 });
  // Age the TTL'd entry past its expiry by rewriting the frontmatter instant.
  const staleFile = fs.readdirSync(path.join(src, 'global'))
    .map((n) => path.join(src, 'global', n))
    .find((f) => fs.readFileSync(f, 'utf8').includes('key: "stale"'));
  fs.writeFileSync(
    staleFile,
    fs.readFileSync(staleFile, 'utf8').replace(/expires_at: .*/, 'expires_at: 2020-01-01T00:00:00.000Z'),
  );

  const home = tmpDir();
  const root = tmpDir();
  await withHome(home, async () => {
    const { result, calls } = await withRemote(() =>
      captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })));
    assert.equal(result.result, 0);
    const posts = writes(calls);
    assert.deepEqual(posts.map((p) => p.body.key), ['live']);
    assert.match(result.text, /2 archived or expired entries/);
  });
});

test('migrate rejects an unknown --to destination', async () => {
  const src = await seedSource();
  const home = tmpDir();
  await withHome(home, async () => {
    const { result, text } = await captured(() => migrate({ from: src, to: 'cloud', dir: tmpDir() }));
    assert.equal(result, 1);
    assert.match(text, /--to must be "home", "project" or "remote"/);
  });
});

test('migrate --to remote reports a persistently unreadable entry and never overwrites it', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => captured(() => migrate(
        { from: src, to: 'remote', yes: true, dir: root },
        { sleepFn: async () => {} },
      )),
      {
        respond: (call) => {
          // Every read of `g1` fails, so the retries are exhausted. A failed
          // read is not an absence: the entry must be reported, never written
          // over on the assumption that it is new.
          if (call.method === 'GET' && new URL(call.url).searchParams.get('key') === 'g1') {
            return { status: 500, body: JSON.stringify({ error: 'upstream boom' }) };
          }
          return null;
        },
      },
    );
    assert.equal(result.result, 1);
    assert.match(result.text, /upstream boom/);
    // Only the entry that could be classified was written; `g1` never was.
    assert.deepEqual(writes(calls).map((w) => w.body.key), ['r1']);
    assert.match(result.text, /1 entry failed \(listed above\)/);
  });
});

test('migrate --to remote retries a transient 5xx read rather than failing the entry', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();
  const slept = [];

  await withHome(home, async () => {
    let failures = 0;
    const { result, calls } = await withRemote(
      () => captured(() => migrate(
        { from: src, to: 'remote', yes: true, dir: root },
        { sleepFn: async (ms) => { slept.push(ms); } },
      )),
      {
        respond: (call) => (call.method === 'GET' && failures++ === 0
          ? { status: 503, body: JSON.stringify({ error: 'upstream restarting' }) }
          : null),
      },
    );
    // A blip on a bulk push must not cost an entry — this is the run shape
    // where a single transient failure is likeliest.
    assert.equal(result.result, 0);
    assert.equal(writes(calls).length, 2);
    assert.deepEqual(slept, [1000]); // exponential backoff, no server hint on a 503
  });
});

test('migrate --to remote retries a rate-limited READ, and reports a clamped TTL', async () => {
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'long', value: 'v', ttl_days: 365 });
  // Push the expiry well past the hosted 365-day maximum.
  const file = fs.readdirSync(path.join(src, 'global')).map((n) => path.join(src, 'global', n))[0];
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace(/expires_at: .*/, 'expires_at: 2099-01-01T00:00:00.000Z'),
  );

  const home = tmpDir();
  const root = tmpDir();
  const slept = [];
  await withHome(home, async () => {
    let reads = 0;
    const { result, calls } = await withRemote(
      () => captured(() => migrate(
        { from: src, to: 'remote', yes: true, dir: root },
        { sleepFn: async (ms) => { slept.push(ms); } },
      )),
      {
        respond: (call) => {
          // A read reports a rate limit by throwing out of `getEntry`, so this
          // pins that the retry path covers reads and not only writes.
          if (call.method === 'GET' && reads++ === 0) {
            return {
              // 7 seconds — deliberately NOT a value the default backoff can
              // produce (that is 1s on the first attempt), so deleting this
              // hint from the stub fails the assertion below.
              status: 429,
              body: JSON.stringify({ error: 'Too many requests', code: 'rate_limited', retryAfterSeconds: 7 }),
            };
          }
          return null;
        },
      },
    );
    assert.equal(result.result, 0);
    assert.deepEqual(slept, [7000]); // the server's hint, not the 1s default backoff
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2); // rejected read + its retry
    assert.equal(writes(calls)[0].body.ttl_days, 365);
    assert.match(result.text, /global::long — TTL shortened to the hosted maximum/);
    assert.match(result.text, /1 entry: TTL shortened to the hosted maximum/);
  });
});

test('migrate --to remote re-pushes an entry whose hosted copy differs', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    // The hosted rows exist but say something else, so the plan must be UPDATE
    // and the writes must happen. Without this the whole suite passes with
    // `sameRemoteEntry` hard-wired to true.
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      {
        respond: (call) => {
          if (call.method !== 'GET') return null;
          const p = new URL(call.url).searchParams;
          return {
            status: 200,
            body: JSON.stringify({
              entries: [{
                id: '00000000-0000-0000-0000-000000000000',
                scope: p.get('scope'), key: p.get('key'),
                value: 'something else entirely',
                tags: [], source_agent: null, trigger: null,
                created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z',
                expires_at: null, archived_at: null,
              }],
            }),
          };
        },
      },
    );
    assert.equal(result.result, 0);
    assert.equal(writes(calls).length, 2);
    assert.match(result.text, /global — 0 add, 1 update/);
    assert.match(result.text, /repo::o\/r — 0 add, 1 update/);
  });
});

test('migrate --to remote is idempotent for padded values and absent provenance', async () => {
  // Two shapes that a naive field-by-field comparison reports as UPDATE on
  // every single run, re-pushing the whole store forever: the hosted write
  // TRIMS `value`, and it COALESCES `origin_*` so a local entry with none can
  // never make the hosted row match it.
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'padded', value: '  padded value  ' });

  const home = tmpDir();
  const root = tmpDir();
  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => quiet(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      {
        respond: (call) => (call.method === 'GET' ? {
          status: 200,
          body: JSON.stringify({
            entries: [{
              id: '00000000-0000-0000-0000-000000000000',
              scope: 'global', key: 'padded',
              value: 'padded value',           // trimmed by the server
              tags: [], source_agent: null, trigger: null,
              origin_repo: 'mthines/lorekit',  // recorded by an earlier write, coalesced
              created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z',
              expires_at: null, archived_at: null,
            }],
          }),
        } : null),
      },
    );
    assert.equal(result, 0);
    assert.equal(writes(calls).length, 0);
  });
});

test('migrate --to remote re-pushes when the hosted expiry is shorter than the local one', async () => {
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'longlived', value: 'v', ttl_days: 300 });

  const home = tmpDir();
  const root = tmpDir();
  await withHome(home, async () => {
    const hosted = (expiresAt) => ({
      status: 200,
      body: JSON.stringify({
        entries: [{
          id: '00000000-0000-0000-0000-000000000000',
          scope: 'global', key: 'longlived', value: 'v',
          tags: [], source_agent: null, trigger: null,
          created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z',
          expires_at: expiresAt, archived_at: null,
        }],
      }),
    });
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 400 * 86_400_000).toISOString();

    // A hosted lesson that dies in a week does not satisfy a 300-day one.
    const shorter = await withRemote(
      () => quiet(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      { respond: (c) => (c.method === 'GET' ? hosted(soon) : null) },
    );
    assert.equal(writes(shorter.calls).length, 1);

    // One that outlives it does, so a re-run after a push stays NOOP even
    // though the local copy keeps ageing and the instants never match.
    const longer = await withRemote(
      () => quiet(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      { respond: (c) => (c.method === 'GET' ? hosted(later) : null) },
    );
    assert.equal(writes(longer.calls).length, 0);
  });
});

test('migrate --to remote with a write-only token pushes without reading', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      {
        token: 'lk_wo_writeonly',
        // Any read would 403. The run must not issue one — the preflight
        // promised the writes still land, and they have to.
        respond: (call) => (call.method === 'GET'
          ? { status: 403, body: JSON.stringify({ error: 'permission denied', code: 'permission_denied' }) }
          : null),
      },
    );
    assert.equal(result.result, 0);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 0);
    assert.equal(writes(calls).length, 2);
    assert.match(result.text, /write-only/);
    assert.match(result.text, /global — 1 add, 0 update/);
  });
});

test('migrate --to remote warns on an unrecognized token prefix but proceeds', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      { token: 'custom_token_from_a_self_host' },
    );
    assert.equal(result.result, 0);
    assert.match(result.text, /unrecognized prefix/);
    assert.equal(writes(calls).length, 2);
  });
});

test('migrate --to remote honours the global --token and --endpoint flags', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    // No configured connection at all — the flags are the only source.
    const { result, calls } = await withRemote(
      () => captured(() => migrate({
        from: src, to: 'remote', yes: true, dir: root,
        endpoint: 'https://flagged.supabase.co/functions/v1/mcp', token: 'lk_rw_flag',
      })),
      { token: null, endpoint: null },
    );
    assert.equal(result.result, 0);
    assert.match(calls[0].url, /^https:\/\/flagged\.supabase\.co\/functions\/v1\//);
  });
});

test('migrate --to remote previews the same losses in a dry run as it reports on apply', async () => {
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'longttl', value: 'v', ttl_days: 365 });
  const file = fs.readdirSync(path.join(src, 'global')).map((n) => path.join(src, 'global', n))[0];
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8')
      .replace(/expires_at: .*/, 'expires_at: 2099-01-01T00:00:00.000Z')
      .replace(/created: .*/, 'created: "3000-01-01T00:00:00.000Z"'),
  );

  const home = tmpDir();
  const root = tmpDir();
  await withHome(home, async () => {
    // A preview that omits "this will be shortened and re-dated" is a preview
    // of a different operation.
    const { result, calls } = await withRemote(() =>
      captured(() => migrate({ from: src, to: 'remote', dir: root })));
    assert.equal(result.result, 0);
    assert.equal(writes(calls).length, 0);
    assert.match(result.text, /would have TTL shortened/);
    assert.match(result.text, /would have unusable created date dropped/);
  });
});

test('migrate --to remote paces itself once the request window fills', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const started = Date.now();
    const { result } = await withRemote(() => captured(() => migrate(
      { from: src, to: 'remote', yes: true, dir: root },
      // One request per 20ms window, so every call after the first must wait.
      // The pacer sleeps in REAL time by design (a fake sleep that never
      // advances the clock would spin its window forever), hence a tiny window
      // rather than an injected clock.
      { maxPerWindow: 1, windowMs: 20 },
    )));
    assert.equal(result.result, 0);
    assert.match(result.text, /staying under the hosted rate limit/);
    // Four requests (2 reads + 2 writes) at one per 20ms window — the run
    // cannot have finished instantly. Without the pacer this is ~0ms.
    assert.ok(Date.now() - started >= 40, 'expected the pacer to slow the run down');
  });
});


test('migrate --to remote gives up on a destination that is systematically down', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    const { result, calls } = await withRemote(
      () => captured(() => migrate(
        { from: src, to: 'remote', yes: true, dir: root },
        { sleepFn: async () => {}, consecutiveFailureLimit: 1 },
      )),
      { respond: () => ({ status: 503, body: JSON.stringify({ error: 'everything is on fire' }) }) },
    );
    // Retrying is worth it for a blip. An outage is not: without a breaker,
    // every remaining entry pays the full retry budget before failing anyway.
    assert.equal(result.result, 1);
    assert.match(result.text, /stopped after 1 consecutive failures/);
    assert.match(result.text, /0 entries migrated before it gave up/);
    // The first entry's read exhausted its attempts; the second was never
    // reached, so the run stopped rather than grinding through the store.
    assert.equal(calls.filter((c) => new URL(c.url).searchParams.get('key') === 'r1').length, 0);
  });
});

test('migrate --to remote does not report a loss for a write that failed', async () => {
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'longttl', value: 'v', ttl_days: 365 });
  const file = fs.readdirSync(path.join(src, 'global')).map((n) => path.join(src, 'global', n))[0];
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace(/expires_at: .*/, 'expires_at: 2099-01-01T00:00:00.000Z'),
  );

  const home = tmpDir();
  const root = tmpDir();
  await withHome(home, async () => {
    const { result } = await withRemote(
      () => captured(() => migrate(
        { from: src, to: 'remote', yes: true, dir: root },
        { sleepFn: async () => {} },
      )),
      {
        respond: (call) => (call.method === 'POST'
          ? { status: 400, body: JSON.stringify({ error: 'bad request' }) }
          : null),
      },
    );
    assert.equal(result.result, 1);
    // The entry never landed, so nothing about it was shortened. Claiming the
    // loss next to "migrated 0 entries" is worse than saying nothing.
    assert.doesNotMatch(result.text, /TTL shortened/);
  });
});

test('migrate --to remote is idempotent for an entry whose TTL exceeds the hosted maximum', async () => {
  const src = tmpDir();
  const store = createLocalStore(src);
  await store.write({ scope: 'global', key: 'forever', value: 'v', ttl_days: 365 });
  const file = fs.readdirSync(path.join(src, 'global')).map((n) => path.join(src, 'global', n))[0];
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace(/expires_at: .*/, 'expires_at: 2099-01-01T00:00:00.000Z'),
  );

  const home = tmpDir();
  const root = tmpDir();
  await withHome(home, async () => {
    // The row a previous push produced: clamped to the API maximum, which is
    // the longest life a write can ask for. Comparing it against the local
    // 2099 would disagree forever and re-push on every single run — for
    // exactly the entries the clamp already warned about.
    const hostedRow = {
      id: '00000000-0000-0000-0000-000000000000',
      scope: 'global', key: 'forever', value: 'v',
      tags: [], source_agent: null, trigger: null,
      created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
      expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      archived_at: null,
    };
    const { result, calls } = await withRemote(
      () => quiet(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      { respond: (c) => (c.method === 'GET' ? { status: 200, body: JSON.stringify({ entries: [hostedRow] }) } : null) },
    );
    assert.equal(result, 0);
    assert.equal(writes(calls).length, 0);
  });
});
