// `lorekit migrate --from local|remote --to local|remote` — cross-store migrate.
//
// Two layers:
//   • unit — the pure helpers (isStoreKeyword / readFields / ttlDaysFromExpiry /
//     sameContent);
//   • integration — the real binary spawned against a mock LoreKit REST endpoint,
//     both directions (remote→local, local→remote), dry-run, and validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isStoreKeyword, readFields, ttlDaysFromExpiry, sameContent,
} from '../src/migrate.mjs';
import { createLocalStore } from '../src/store/local.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const DAY_MS = 24 * 60 * 60 * 1000;

// ── unit: pure helpers ────────────────────────────────────────────────────────

test('isStoreKeyword recognises only local/remote', () => {
  assert.equal(isStoreKeyword('local'), true);
  assert.equal(isStoreKeyword('remote'), true);
  assert.equal(isStoreKeyword('home'), false);
  assert.equal(isStoreKeyword('.lore'), false);
  assert.equal(isStoreKeyword(null), false);
});

test('readFields normalises local (created/updated) and remote (created_at/updated_at)', () => {
  const local = readFields({ scope: 'global', key: 'k', value: 'v', tags: ['a'], created: 'C', updated: 'U' });
  assert.equal(local.created, 'C');
  assert.equal(local.updated, 'U');
  const remote = readFields({ scope: 'global', key: 'k', value: 'v', created_at: 'C2', updated_at: 'U2' });
  assert.equal(remote.created, 'C2');
  assert.equal(remote.updated, 'U2');
  // Missing tags → [], null value → ''
  const bare = readFields({ scope: 'global', key: 'k' });
  assert.deepEqual(bare.tags, []);
  assert.equal(bare.value, '');
});

test('ttlDaysFromExpiry converts a future expiry, skips absent/past/invalid, caps at 365', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  assert.deepEqual(ttlDaysFromExpiry(null, now), {});
  assert.deepEqual(ttlDaysFromExpiry('garbage', now), {});
  assert.deepEqual(ttlDaysFromExpiry('2025-12-31T00:00:00.000Z', now), {}); // past
  assert.deepEqual(ttlDaysFromExpiry(new Date(now.getTime() + 10 * DAY_MS).toISOString(), now), { ttl_days: 10 });
  assert.deepEqual(ttlDaysFromExpiry(new Date(now.getTime() + 5000 * DAY_MS).toISOString(), now), { ttl_days: 365 });
});

test('sameContent compares value + tag set only (timestamps ignored)', () => {
  assert.equal(sameContent({ value: 'v', tags: ['a', 'b'] }, { value: 'v', tags: ['b', 'a'] }), true);
  assert.equal(sameContent({ value: 'v', tags: [] }, { value: 'w', tags: [] }), false);
  assert.equal(sameContent({ value: 'v', tags: ['a'] }, { value: 'v', tags: ['b'] }), false);
  assert.equal(sameContent(null, { value: 'v' }), false);
});

// ── integration: mock remote + spawned binary ─────────────────────────────────

// A mock LoreKit REST endpoint. GET /memories/scopes → the scope inventory;
// GET /memories?scope=… → that scope's entries; POST /memories → capture the
// body (for the local→remote direction) and 200.
function startMockRemote({ byScope = {}, posts = [] } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      // The REST base carries a trailing slash, so the path arrives double-slashed
      // (e.g. `//memories/scopes`). Match on the raw path string rather than
      // `new URL()`, which would read a leading `//` as a protocol-relative host.
      const [rawPath, query = ''] = req.url.split('?');
      const params = new URLSearchParams(query);
      res.setHeader('content-type', 'application/json');
      if (rawPath.endsWith('/memories/scopes')) {
        const scopes = Object.entries(byScope).map(([scope, entries]) => ({ scope, count: entries.length }));
        res.end(JSON.stringify({ scopes }));
      } else if (rawPath.endsWith('/memories') && req.method === 'POST') {
        posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, inserted: true }));
      } else if (rawPath.endsWith('/memories') && req.method === 'GET') {
        // Real cursor pagination keyed by a numeric offset, so a scope with more
        // than one page exercises the CLI's paging loop. Caps at the server's 100.
        const all = byScope[params.get('scope')] || [];
        const limit = Math.min(Number(params.get('limit')) || all.length, 100);
        const start = params.get('cursor') ? Number(params.get('cursor')) : 0;
        const page = all.slice(start, start + limit);
        const next = start + limit;
        const hasMore = next < all.length;
        res.end(JSON.stringify({ entries: page, hasMore, nextCursor: hasMore ? String(next) : null }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  return server;
}

// Async spawn (NOT spawnSync): the mock HTTP server runs on THIS process's event
// loop, so a synchronous child would block the parent from ever serving the
// child's request — a deadlock. `spawn` keeps the parent loop free to respond.
function runMigrate(root, home, extraArgs = [], extraEnv = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    LOREKIT_HOME: home,
    LOREKIT_TELEMETRY: '0',
  };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  delete env.LOREKIT_STORE;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'migrate', ...extraArgs, '--dir', root], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withServer(server, fn) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('migrate --from remote --to local pulls entries and preserves created/expires_at', async () => {
  const home = tmp('lk-xmig-home-');
  const root = tmp('lk-xmig-root-');
  const expiresAt = new Date(Date.now() + 20 * DAY_MS).toISOString();
  const server = startMockRemote({
    byScope: {
      global: [{
        scope: 'global', key: 'g1', value: 'gv', tags: ['x'],
        created_at: '2024-05-01T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z',
        expires_at: expiresAt, origin_repo: 'o/r',
      }],
    },
  });
  await withServer(server, async (port) => {
    const env = { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_rw_test' };
    // Dry-run writes nothing.
    const dry = await runMigrate(root, home, ['--from', 'remote', '--to', 'local'], env);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(createLocalStore(home).getEntry({ scope: 'global', key: 'g1' }), null);

    // Apply pulls it down, verbatim.
    const res = await runMigrate(root, home, ['--from', 'remote', '--to', 'local', '--yes'], env);
    assert.equal(res.status, 0, res.stderr);
    const entry = createLocalStore(home).getEntry({ scope: 'global', key: 'g1' });
    assert.equal(entry.value, 'gv');
    assert.equal(entry.created, '2024-05-01T00:00:00.000Z'); // created_at → created, preserved
    assert.equal(entry.expires_at, expiresAt);               // absolute expiry preserved verbatim
    assert.equal(entry.origin_repo, 'o/r');
  });
});

test('migrate --from local --to remote pushes entries, converting expiry to ttl_days', async () => {
  const home = tmp('lk-xmig-home2-');
  const root = tmp('lk-xmig-root2-');
  // Seed the local store with an expiring, provenance-tagged memory.
  await createLocalStore(home).write({
    scope: 'global', key: 'k', value: 'v', tags: ['t'], ttl_days: 30, origin_repo: 'o/r',
  });
  const posts = [];
  const server = startMockRemote({ posts });
  await withServer(server, async (port) => {
    const env = { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_rw_test' };
    // Dry-run posts nothing.
    await runMigrate(root, home, ['--from', 'local', '--to', 'remote'], env);
    assert.equal(posts.length, 0);

    const res = await runMigrate(root, home, ['--from', 'local', '--to', 'remote', '--yes'], env);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(posts.length, 1);
    const body = posts[0];
    assert.equal(body.scope, 'global');
    assert.equal(body.key, 'k');
    assert.equal(body.value, 'v');
    assert.deepEqual(body.tags, ['t']);
    assert.match(body.created_at, /^\d{4}-\d\d-\d\dT/); // creation date preserved
    assert.ok(body.ttl_days >= 29 && body.ttl_days <= 30, `ttl_days ≈ 30 (got ${body.ttl_days})`);
    assert.equal(body.origin_repo, 'o/r');
  });
});

test('migrate --from remote --to local pages a scope with more than 100 memories', async () => {
  const home = tmp('lk-xmig-page-home-');
  const root = tmp('lk-xmig-page-root-');
  const many = Array.from({ length: 150 }, (_, i) => ({
    scope: 'global', key: `g${i}`, value: `v${i}`, tags: [],
    created_at: '2024-01-01T00:00:00.000Z',
  }));
  const server = startMockRemote({ byScope: { global: many } });
  await withServer(server, async (port) => {
    const env = { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_rw_test' };
    const res = await runMigrate(root, home, ['--from', 'remote', '--to', 'local', '--yes'], env);
    assert.equal(res.status, 0, res.stderr);
    const store = createLocalStore(home);
    // Every page landed — including the boundary rows on either side of page 1/2.
    assert.equal((await store.list({ scope: 'global' })).entries.length, 150);
    assert.ok(store.getEntry({ scope: 'global', key: 'g0' }));
    assert.ok(store.getEntry({ scope: 'global', key: 'g100' }));
    assert.ok(store.getEntry({ scope: 'global', key: 'g149' }));
  });
});

test('migrate --from remote --to local honours --scope (only that scope moves)', async () => {
  const home = tmp('lk-xmig-scope-home-');
  const root = tmp('lk-xmig-scope-root-');
  const server = startMockRemote({
    byScope: {
      global: [{ scope: 'global', key: 'g1', value: 'gv', created_at: '2024-01-01T00:00:00.000Z' }],
      'repo::o/r': [{ scope: 'repo::o/r', key: 'r1', value: 'rv', created_at: '2024-01-01T00:00:00.000Z' }],
    },
  });
  await withServer(server, async (port) => {
    const env = { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_rw_test' };
    const res = await runMigrate(root, home, ['--from', 'remote', '--to', 'local', '--scope', 'global', '--yes'], env);
    assert.equal(res.status, 0, res.stderr);
    const store = createLocalStore(home);
    assert.ok(store.getEntry({ scope: 'global', key: 'g1' }));
    assert.equal(store.getEntry({ scope: 'repo::o/r', key: 'r1' }), null); // filtered out
  });
});

test('migrate rejects remote↔remote and same-store', async () => {
  const home = tmp('lk-xmig-home3-');
  const root = tmp('lk-xmig-root3-');
  const res = await runMigrate(root, home, ['--from', 'remote', '--to', 'remote'],
    { LOREKIT_MCP_URL: 'http://127.0.0.1:1/mcp', LOREKIT_TOKEN: 'lk_rw_test' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /nothing to move/);
});

test('migrate --from local --to remote errors when remote is not configured', async () => {
  const home = tmp('lk-xmig-home4-');
  const root = tmp('lk-xmig-root4-');
  const res = await runMigrate(root, home, ['--from', 'local', '--to', 'remote']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not configured/);
});
