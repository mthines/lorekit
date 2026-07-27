// `lorekit show <scope> <key>` — inspect ONE lesson in full across both stores.
//
// Two layers of coverage:
//   • unit — the pure divergence check (`recordsDiverge`);
//   • integration — the real binary spawned in a temp project with an isolated
//     HOME, asserting the offline lookup (full untruncated value + tags), the
//     not-found exit code, `--json`, missing-arg usage errors, deny suppression,
//     and — via a mock remote — a remote-only hit and an offline/remote divergence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordsDiverge } from '../src/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: recordsDiverge ──────────────────────────────────────────────────────

test('recordsDiverge flags a value or tag-set mismatch, ignores absence', () => {
  const a = { value: 'x', tags: ['t'] };
  assert.equal(recordsDiverge(a, { value: 'x', tags: ['t'] }), false); // identical
  assert.equal(recordsDiverge(a, { value: 'y', tags: ['t'] }), true); // value differs
  assert.equal(recordsDiverge(a, { value: 'x', tags: ['u'] }), true); // tags differ
  assert.equal(recordsDiverge(a, null), false); // one side missing → not a divergence
  assert.equal(recordsDiverge(null, a), false);
});

// ── integration fixtures ──────────────────────────────────────────────────────

const LONG_VALUE =
  'This lesson body is deliberately much longer than the 72-character preview ' +
  'truncation used by the list view, so we can prove show prints it in full.';

function entry({ scope, key, value, tags = [] }) {
  const fm = {
    scope,
    key,
    tags,
    source_agent: 'aw',
    trigger: 'manual',
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at: null,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${value}\n`;
}

function seedProject() {
  const root = tmp('lk-show-proj-');
  const home = tmp('lk-show-home-');
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(store, 'global', 'a.md'),
    entry({ scope: 'global', key: 'prefer-guard-clauses', value: LONG_VALUE, tags: ['style', 'ops'] }),
  );
  fs.writeFileSync(
    path.join(store, 'global', 'b.md'),
    entry({ scope: 'global', key: 'shared-key', value: 'offline value' }),
  );
  return { root, home };
}

function runShow(root, home, extraArgs = [], extraEnv = {}) {
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
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [BIN, 'show', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env,
  });
}

// Async variant — required whenever a test runs an in-process mock HTTP server:
// spawnSync would block THIS process's event loop, so the mock could never
// answer the child's fetch. spawn keeps the loop free to serve it.
function runShowAsync(root, home, extraArgs = [], extraEnv = {}) {
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
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'show', ...extraArgs, '--dir', root], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ── integration: offline lookup ───────────────────────────────────────────────

test('show prints a lesson in full (untruncated) with its tags (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global', 'prefer-guard-clauses']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Offline/);
  // The FULL value is present — not the ellipsis-truncated preview `list` shows.
  assert.match(res.stdout, /prints it in full\./);
  assert.doesNotMatch(res.stdout, /…/);
  assert.match(res.stdout, /style, ops/); // tags
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

test('show --json emits the full normalized record + which store', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global', 'prefer-guard-clauses', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, 'global');
  assert.equal(out.key, 'prefer-guard-clauses');
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.found, true);
  assert.equal(out.offline.record.value, LONG_VALUE); // full body, not truncated
  assert.deepEqual(out.offline.record.tags, ['style', 'ops']);
  assert.equal(out.remote.available, false);
  assert.equal(out.remote.found, false);
  assert.equal(out.diverged, false);
});

test('show exits non-zero and notes when the key is found in no store', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global', 'does-not-exist']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no lesson found/);
  assert.match(res.stdout, /no such key in this store/);
});

test('show --json for a missing key reports found:false in both sections', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global', 'does-not-exist', '--json']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.found, false);
  assert.equal(out.remote.found, false);
});

test('show without a key is a usage error', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
  assert.match(res.stderr, /show <scope> <key>/);
});

test('show without any positional args is a usage error', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

// ── integration: deny-wins suppression ────────────────────────────────────────

test('LOREKIT_DENY=local suppresses the offline section', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global', 'prefer-guard-clauses', '--json'], {
    LOREKIT_DENY: 'local',
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
  // With local denied and no remote configured, the key is unreadable → exit 1.
  assert.equal(res.status, 1);
});

// ── integration: a configured (mock) remote ───────────────────────────────────

// A mock LoreKit MCP endpoint answering `memory.read` from a `${scope}::${key}`
// fixture map — returning a null payload (→ null entry) when absent.
function startMockRemote(byKey) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let args = {};
      try {
        args = JSON.parse(body)?.params?.arguments ?? {};
      } catch {
        /* ignore */
      }
      const found = byKey[`${args.scope}::${args.key}`] || null;
      const payload = found ? { entry: found } : null;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      );
    });
  });
  return server;
}

test('show surfaces a remote-only lesson and notes the offline store lacks it', async () => {
  const { root, home } = seedProject();
  const server = startMockRemote({
    'global::remote-only': {
      scope: 'global',
      key: 'remote-only',
      value: 'Lives only in the hosted store.',
      tags: [],
      updated_at: '2026-07-01T00:00:00Z',
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runShowAsync(root, home, ['global', 'remote-only', '--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.offline.found, false); // absent offline
    assert.equal(out.remote.available, true);
    assert.equal(out.remote.found, true);
    assert.equal(out.remote.record.value, 'Lives only in the hosted store.');
    assert.equal(out.diverged, false);
  } finally {
    server.close();
  }
});

test('show flags a divergence when the same key differs between the two stores', async () => {
  const { root, home } = seedProject(); // offline `shared-key` value = 'offline value'
  const server = startMockRemote({
    'global::shared-key': {
      scope: 'global',
      key: 'shared-key',
      value: 'remote value', // deliberately different from the offline copy
      tags: [],
      updated_at: '2026-07-05T00:00:00Z',
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runShowAsync(root, home, ['global', 'shared-key', '--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.offline.found, true);
    assert.equal(out.remote.found, true);
    assert.equal(out.offline.record.value, 'offline value');
    assert.equal(out.remote.record.value, 'remote value');
    assert.equal(out.diverged, true);

    // And the human view flags it too.
    const human = await runShowAsync(root, home, ['global', 'shared-key'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /divergence/);
  } finally {
    server.close();
  }
});
