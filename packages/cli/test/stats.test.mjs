// `lorekit stats` — count the applicable lessons per scope and per store,
// rendered in the same Offline / Remote split as `list`.
//
// Two layers of coverage:
//   • unit — the pure tally (`tallyGroups`): per-scope counts, a read error
//     counting as 0 while staying surfaced, and total reuse/re-derivation;
//   • integration — the real binary spawned in a temp project with an isolated
//     HOME, asserting offline counts, the per-scope breakdown, `--scope`,
//     `--json`, deny suppression, an empty store, graceful remote degradation,
//     and a mock remote contributing its own counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tallyGroups } from '../src/shared/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: tallyGroups (the pure per-scope counter) ────────────────────────────

test('tallyGroups counts entries per scope and reuses gather()’s total', () => {
  const gathered = {
    total: 3,
    groups: [
      { scope: 'global', error: null, entries: [{ key: 'a' }, { key: 'b' }] },
      { scope: 'project::x', error: null, entries: [{ key: 'c' }] },
    ],
  };
  const { perScope, total } = tallyGroups(gathered);
  assert.equal(total, 3);
  assert.deepEqual(perScope, [
    { scope: 'global', count: 2, error: null },
    { scope: 'project::x', count: 1, error: null },
  ]);
});

test('tallyGroups counts a read-errored scope as 0 but keeps the error', () => {
  const gathered = {
    groups: [
      { scope: 'global', error: 'fetch failed', entries: [] },
      { scope: 'repo::a/b', error: null, entries: [{ key: 'z' }] },
    ],
  };
  const { perScope, total } = tallyGroups(gathered);
  assert.equal(total, 1); // no gather total → re-derived from the counts
  assert.equal(perScope[0].count, 0);
  assert.equal(perScope[0].error, 'fetch failed');
  assert.equal(perScope[1].count, 1);
});

test('tallyGroups on an empty gather is zero everywhere', () => {
  assert.deepEqual(tallyGroups({}), { perScope: [], total: 0 });
  assert.deepEqual(tallyGroups({ groups: [] }), { perScope: [], total: 0 });
});

// ── integration fixtures ──────────────────────────────────────────────────────

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

// A project with an opted-in project-tier store: 1 global lesson + 2 project
// lessons, under the two scopes that resolve for ANY directory (no git remote).
function seedProject() {
  const root = tmp('lk-stats-proj-');
  const home = tmp('lk-stats-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));
  write('global/a.md', { scope: 'global', key: 'prefer-guard-clauses', value: 'Use early returns.' });
  write(`project/${projectName}/b.md`, {
    scope: `project::${projectName}`,
    key: 'widget-build-flags',
    value: 'Needs --no-sandbox.',
  });
  write(`project/${projectName}/c.md`, {
    scope: `project::${projectName}`,
    key: 'widget-cache-tip',
    value: 'Cache is flaky.',
  });
  return { root, home, projectName };
}

// An empty project — the store dir exists but holds no lessons.
function seedEmpty() {
  const root = tmp('lk-stats-empty-');
  const home = tmp('lk-stats-ehome-');
  fs.mkdirSync(path.join(root, '.lorekit'), { recursive: true });
  return { root, home };
}

function baseEnv(home, extraEnv) {
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
  return env;
}

function runStats(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'stats', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

// Async variant for tests that boot an in-process mock HTTP server (spawnSync
// would block the event loop and the mock could never answer the child).
function runStatsAsync(root, home, extraArgs = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'stats', ...extraArgs, '--dir', root], {
      env: baseEnv(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ── integration: offline counts ───────────────────────────────────────────────

test('stats counts the offline lessons and degrades remote gracefully (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runStats(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Offline/);
  assert.match(res.stdout, /total/);
  // Remote not configured → a graceful note, never an error line.
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

test('stats --json emits per-scope counts and a per-store total', () => {
  const { root, home, projectName } = seedProject();
  const res = runStats(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.total, 3);
  const byScope = Object.fromEntries(out.offline.scopes.map((s) => [s.scope, s.count]));
  assert.equal(byScope['global'], 1);
  assert.equal(byScope[`project::${projectName}`], 2);
  // Remote is unconfigured — reported unavailable with a zero total.
  assert.equal(out.remote.available, false);
  assert.equal(out.remote.total, 0);
  assert.match(out.remote.reason, /endpoint|token/);
});

test('stats --scope narrows the counts to a single scope', () => {
  const { root, home } = seedProject();
  const res = runStats(root, home, ['--scope', 'global', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, ['global']);
  assert.equal(out.offline.total, 1);
  assert.deepEqual(out.offline.scopes, [{ scope: 'global', count: 1, error: null }]);
});

test('stats on an empty store reports zero counts (exit 0)', () => {
  const { root, home } = seedEmpty();
  const res = runStats(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.total, 0);
  // Every applicable scope still appears, each at 0.
  assert.ok(out.offline.scopes.length >= 1);
  assert.ok(out.offline.scopes.every((s) => s.count === 0));
});

// ── integration: deny-wins suppression ────────────────────────────────────────

test('LOREKIT_DENY=local suppresses the offline counts', () => {
  const { root, home } = seedProject();
  const res = runStats(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

test('LOREKIT_DENY=remote suppresses the remote counts, offline still counts', () => {
  const { root, home } = seedProject();
  const res = runStats(root, home, ['--json'], { LOREKIT_DENY: 'remote' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /deny constraint/);
  assert.equal(out.offline.total, 3);
});

// ── integration: a configured (mock) remote ───────────────────────────────────

// A mock LoreKit REST endpoint answering GET /memories?scope=X and
// GET /memories/scopes from a fixture. `stats` now uses the /scopes aggregate
// for remote counts (exact at any scale), so the mock must implement it.
//
// Note: when LOREKIT_MCP_URL=http://host:port/mcp, mcpToRestBase strips the
// /mcp suffix, leaving a bare origin with a trailing slash. The REST client
// then concatenates '/memories/scopes', producing a double-slash path
// (//memories/scopes). We therefore match on req.url directly rather than
// parsing it through `new URL`, which would mis-parse //memories/scopes as a
// protocol-relative URL with host=memories and path=/scopes.
function startMockRemote(byScope) {
  const server = http.createServer((req, res) => {
    res.setHeader(`content-type`, `application/json`);
    // Strip any leading slashes for robust matching (handles single or double).
    const rawPath = req.url.split(`?`)[0].replace(/^\/+/, `/`);
    if (rawPath === `/memories/scopes`) {
      // Aggregate: one {scope, count} row per scope in the fixture.
      const scopes = Object.entries(byScope).map(([scope, entries]) => ({
        scope,
        count: (entries || []).length,
      }));
      res.end(JSON.stringify({ scopes }));
      return;
    }
    const qs = req.url.includes(`?`) ? req.url.slice(req.url.indexOf(`?`) + 1) : ``;
    const params = new URLSearchParams(qs);
    const scope = params.get(`scope`);
    const entries = (scope ? byScope[scope] : null) || [];
    res.end(JSON.stringify({ entries, hasMore: false, nextCursor: null }));
  });
  return server;
}

test('stats counts a configured remote store alongside offline', async () => {
  const { root, home } = seedProject();
  const server = startMockRemote({
    global: [
      { scope: 'global', key: 'remote-a', value: 'x', updated_at: '2026-07-01T00:00:00Z' },
      { scope: 'global', key: 'remote-b', value: 'y', updated_at: '2026-07-02T00:00:00Z' },
    ],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runStatsAsync(root, home, ['--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.remote.available, true);
    assert.equal(out.remote.total, 2);
    const byScope = Object.fromEntries(out.remote.scopes.map((s) => [s.scope, s.count]));
    assert.equal(byScope['global'], 2);
    // Offline is counted independently and is unaffected by the remote.
    assert.equal(out.offline.total, 3);
  } finally {
    server.close();
  }
});