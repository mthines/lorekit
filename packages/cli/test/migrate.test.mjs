// `lorekit migrate` — dry-run/apply/idempotency and scope routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';
import { createLocalStore } from '../src/store/local.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-mig-'));
}

// Silence migrate's stdout/stderr for the duration of `fn`.
async function quiet(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = errw;
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

// Capture migrate's stdout/stderr instead of discarding it, for the reports
// whose whole job is to tell the user what happened.
async function captured(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  let text = '';
  process.stdout.write = (s) => { text += s; return true; };
  process.stderr.write = (s) => { text += s; return true; };
  try {
    const result = await fn();
    return { result, text };
  } finally {
    process.stdout.write = out;
    process.stderr.write = errw;
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

test('migrate --to remote reports an unreadable entry and never overwrites it', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    let reads = 0;
    const { result, calls } = await withRemote(
      () => captured(() => migrate({ from: src, to: 'remote', yes: true, dir: root })),
      {
        respond: (call) => {
          // Fail the first classifying read. A failed read is not an absence,
          // so the entry must be reported — never written over on the
          // assumption that it is new.
          if (call.method === 'GET' && reads++ === 0) {
            return { status: 500, body: JSON.stringify({ error: 'upstream boom' }) };
          }
          return null;
        },
      },
    );
    assert.equal(result.result, 1);
    assert.match(result.text, /upstream boom/);
    assert.equal(writes(calls).length, 1); // only the entry that could be classified
    assert.match(result.text, /1 entry failed \(listed above\)/);
  });
});
