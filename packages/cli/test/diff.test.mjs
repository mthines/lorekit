// `lorekit diff` — compare the offline and remote stores for the applicable
// scopes and report local-only / remote-only / conflicting keys, per scope.
//
// Two layers of coverage:
//   • unit — the pure set-diff (`diffGroups`): local-only, remote-only,
//     value-conflict, tag-conflict, identical→empty, and per-scope error
//     handling;
//   • integration — the real binary spawned in a temp project with an isolated
//     HOME: the not-comparable note when the remote is unconfigured or a store
//     is denied (exit 0), and — via a mock remote — every divergence class,
//     an in-sync result, `--json`, `--scope`, and multiple scopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffGroups } from '../src/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: diffGroups (the pure set-diff) ──────────────────────────────────────

// Build a gather()-shaped result from a compact { scope: [entry...] } map.
function gathered(byScope) {
  return {
    groups: Object.entries(byScope).map(([scope, entries]) => ({ scope, error: null, entries })),
  };
}

test('diffGroups classifies local-only, remote-only, and value-conflicting keys', () => {
  const offline = gathered({
    global: [
      { key: 'same', value: 'v', tags: [] },
      { key: 'diff', value: 'offline', tags: [] },
      { key: 'only-local', value: 'l', tags: [] },
    ],
  });
  const remote = gathered({
    global: [
      { key: 'same', value: 'v', tags: [] },
      { key: 'diff', value: 'remote', tags: [] },
      { key: 'only-remote', value: 'r', tags: [] },
    ],
  });
  const { groups, totals } = diffGroups(offline, remote);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(g.localOnly.map((e) => e.key), ['only-local']);
  assert.deepEqual(g.remoteOnly.map((e) => e.key), ['only-remote']);
  assert.deepEqual(g.conflicting.map((c) => c.key), ['diff']);
  assert.equal(g.conflicting[0].local.value, 'offline');
  assert.equal(g.conflicting[0].remote.value, 'remote');
  assert.deepEqual(totals, { localOnly: 1, remoteOnly: 1, conflicting: 1 });
});

test('diffGroups treats a tag-set mismatch as a conflict (same value)', () => {
  const offline = gathered({ global: [{ key: 'k', value: 'v', tags: ['a'] }] });
  const remote = gathered({ global: [{ key: 'k', value: 'v', tags: ['b'] }] });
  const { groups, totals } = diffGroups(offline, remote);
  assert.deepEqual(groups[0].conflicting.map((c) => c.key), ['k']);
  assert.equal(totals.conflicting, 1);
  assert.equal(totals.localOnly, 0);
  assert.equal(totals.remoteOnly, 0);
});

test('diffGroups on identical stores yields an empty diff', () => {
  const same = () => gathered({ global: [{ key: 'k', value: 'v', tags: ['a'] }] });
  const { groups, totals } = diffGroups(same(), same());
  assert.deepEqual(totals, { localOnly: 0, remoteOnly: 0, conflicting: 0 });
  assert.deepEqual(groups[0].localOnly, []);
  assert.deepEqual(groups[0].remoteOnly, []);
  assert.deepEqual(groups[0].conflicting, []);
});

test('diffGroups unions scopes present in only one store', () => {
  const offline = gathered({ 'project::x': [{ key: 'a', value: '1' }] });
  const remote = gathered({ global: [{ key: 'b', value: '2' }] });
  const { groups, totals } = diffGroups(offline, remote);
  const byScope = Object.fromEntries(groups.map((g) => [g.scope, g]));
  assert.deepEqual(byScope['project::x'].localOnly.map((e) => e.key), ['a']);
  assert.deepEqual(byScope['global'].remoteOnly.map((e) => e.key), ['b']);
  assert.equal(totals.localOnly, 1);
  assert.equal(totals.remoteOnly, 1);
});

test('diffGroups marks a scope errored on either side and never mislabels its keys', () => {
  const offline = { groups: [{ scope: 'global', error: 'fetch failed', entries: [] }] };
  const remote = gathered({ global: [{ key: 'b', value: '2' }] });
  const { groups, totals } = diffGroups(offline, remote);
  assert.equal(groups[0].error, 'fetch failed');
  // The remote key is NOT reported as remote-only — the offline side is unknown.
  assert.deepEqual(groups[0].remoteOnly, []);
  assert.deepEqual(totals, { localOnly: 0, remoteOnly: 0, conflicting: 0 });
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

// Offline store: under `global` — `shared-same`, `shared-diff` (offline value),
// `only-offline`; under the project scope — `proj-offline`.
function seedProject() {
  const root = tmp('lk-diff-proj-');
  const home = tmp('lk-diff-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));
  write('global/a.md', { scope: 'global', key: 'shared-same', value: 'identical body' });
  write('global/b.md', { scope: 'global', key: 'shared-diff', value: 'offline body' });
  write('global/c.md', { scope: 'global', key: 'only-offline', value: 'lives offline' });
  write(`project/${projectName}/d.md`, {
    scope: `project::${projectName}`,
    key: 'proj-offline',
    value: 'project offline',
  });
  return { root, home, projectName };
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

function runDiff(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'diff', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

// Async variant for tests that boot an in-process mock HTTP server.
function runDiffAsync(root, home, extraArgs = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'diff', ...extraArgs, '--dir', root], {
      env: baseEnv(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// A mock LoreKit MCP endpoint answering `memory.list` per scope from a fixture.
function startMockRemote(byScope) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let scope = null;
      try {
        scope = JSON.parse(body)?.params?.arguments?.scope ?? null;
      } catch {
        /* ignore */
      }
      const entries = byScope[scope] || [];
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ entries }) }] },
        }),
      );
    });
  });
  return server;
}

// ── integration: not comparable (a diff needs BOTH stores) ────────────────────

test('diff with no remote configured prints a clear note and exits 0', () => {
  const { root, home } = seedProject();
  const res = runDiff(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /remote unavailable/);
  assert.match(res.stdout, /both must be readable/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

test('diff --json reports comparable:false when the remote is unconfigured', () => {
  const { root, home } = seedProject();
  const res = runDiff(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.comparable, false);
  assert.equal(out.offline.available, true);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /endpoint|token/);
});

test('LOREKIT_DENY=local makes the diff not comparable (offline denied)', () => {
  const { root, home } = seedProject();
  const res = runDiff(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.comparable, false);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

// ── integration: a configured (mock) remote — the real diff ───────────────────

// A remote whose `global` scope shares `shared-same` (identical), differs on
// `shared-diff`, adds `only-remote`, and omits `only-offline`.
function divergentRemote(projectName) {
  return startMockRemote({
    global: [
      { scope: 'global', key: 'shared-same', value: 'identical body', updated_at: '2026-07-01T00:00:00Z' },
      { scope: 'global', key: 'shared-diff', value: 'remote body', updated_at: '2026-07-02T00:00:00Z' },
      { scope: 'global', key: 'only-remote', value: 'lives remote', updated_at: '2026-07-03T00:00:00Z' },
    ],
    [`project::${projectName}`]: [],
  });
}

test('diff --json detects local-only, remote-only, and conflicting keys', async () => {
  const { root, home, projectName } = seedProject();
  const server = divergentRemote(projectName);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runDiffAsync(root, home, ['--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.comparable, true);
    assert.equal(out.totals.localOnly, 2); // only-offline (global) + proj-offline (project)
    assert.equal(out.totals.remoteOnly, 1); // only-remote (global)
    assert.equal(out.totals.conflicting, 1); // shared-diff (global)

    const global = out.groups.find((g) => g.scope === 'global');
    assert.deepEqual(global.localOnly.map((e) => e.key), ['only-offline']);
    assert.deepEqual(global.remoteOnly.map((e) => e.key), ['only-remote']);
    assert.deepEqual(global.conflicting.map((c) => c.key), ['shared-diff']);
    assert.equal(global.conflicting[0].local.value, 'offline body');
    assert.equal(global.conflicting[0].remote.value, 'remote body');

    // The project scope has an offline lesson but no remote counterpart.
    const proj = out.groups.find((g) => g.scope === `project::${projectName}`);
    assert.deepEqual(proj.localOnly.map((e) => e.key), ['proj-offline']);
  } finally {
    server.close();
  }
});

test('diff human output groups the divergences and flags conflicts', async () => {
  const { root, home, projectName } = seedProject();
  const server = divergentRemote(projectName);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runDiffAsync(root, home, [], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local-only/);
    assert.match(res.stdout, /only-offline/);
    assert.match(res.stdout, /Remote-only/);
    assert.match(res.stdout, /only-remote/);
    assert.match(res.stdout, /Conflicting/);
    assert.match(res.stdout, /shared-diff/);
    // The identical key is never listed as a divergence.
    assert.doesNotMatch(res.stdout, /shared-same/);
  } finally {
    server.close();
  }
});

test('diff --scope narrows to a single scope', async () => {
  const { root, home } = seedProject();
  const server = divergentRemote('unused');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runDiffAsync(root, home, ['--scope', 'global', '--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.scopes, ['global']);
    assert.equal(out.groups.length, 1);
    assert.equal(out.groups[0].scope, 'global');
    // The project-scope local-only key is now out of scope.
    assert.equal(out.totals.localOnly, 1); // only only-offline remains
  } finally {
    server.close();
  }
});

test('diff reports an in-sync result when the stores match', async () => {
  const { root, home } = seedProject();
  // A remote that mirrors offline global exactly (and the project scope), so
  // there is no divergence at all.
  const projectName = path.basename(root).toLowerCase();
  const server = startMockRemote({
    global: [
      { scope: 'global', key: 'shared-same', value: 'identical body', updated_at: '2026-07-01T00:00:00Z' },
      { scope: 'global', key: 'shared-diff', value: 'offline body', updated_at: '2026-07-02T00:00:00Z' },
      { scope: 'global', key: 'only-offline', value: 'lives offline', updated_at: '2026-07-03T00:00:00Z' },
    ],
    [`project::${projectName}`]: [
      { scope: `project::${projectName}`, key: 'proj-offline', value: 'project offline', updated_at: '2026-07-04T00:00:00Z' },
    ],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runDiffAsync(root, home, ['--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.comparable, true);
    assert.deepEqual(out.totals, { localOnly: 0, remoteOnly: 0, conflicting: 0 });

    const human = await runDiffAsync(root, home, [], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.match(human.stdout, /in sync/);
  } finally {
    server.close();
  }
});
