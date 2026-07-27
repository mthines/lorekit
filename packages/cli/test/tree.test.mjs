// `lorekit tree` — the scope precedence hierarchy: which lesson WINS per key and
// which are shadowed, mirroring the hook engine's resolution order.
//
// Two layers of coverage:
//   • unit — the pure `resolvePrecedence`: first-seen (most-specific) wins,
//     broader duplicates are shadowed, read errors pass through, empty is empty;
//   • integration — the real binary spawned in a git-backed temp project (so the
//     branch/repo/global `readOrder` resolves) with a duplicate key at three
//     scopes, asserting the winner/shadowed verdict, `--scope`, `--json`, deny
//     suppression, an empty store, and a mock remote resolved independently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePrecedence } from '../src/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: resolvePrecedence (the pure precedence core) ────────────────────────

test('resolvePrecedence: the first (most-specific) scope wins a duplicate key', () => {
  const groups = [
    { scope: 'branch::a/b::x', error: null, entries: [{ key: 'shared', value: 'branch' }] },
    { scope: 'repo::a/b', error: null, entries: [{ key: 'shared', value: 'repo' }] },
    { scope: 'global', error: null, entries: [{ key: 'shared', value: 'global' }, { key: 'g', value: 'only' }] },
  ];
  const { groups: out, winners, winningTotal, shadowedTotal } = resolvePrecedence({ groups });
  assert.equal(out[0].entries[0].winning, true);
  assert.equal(out[0].entries[0].shadowedBy, null);
  assert.equal(out[1].entries[0].winning, false);
  assert.equal(out[1].entries[0].shadowedBy, 'branch::a/b::x');
  assert.equal(out[2].entries[0].winning, false);
  assert.equal(out[2].entries[0].shadowedBy, 'branch::a/b::x');
  assert.equal(out[2].entries[1].winning, true); // `g` is unique → wins
  assert.equal(winningTotal, 2);
  assert.equal(shadowedTotal, 2);
  assert.deepEqual(winners, [
    { scope: 'branch::a/b::x', key: 'shared' },
    { scope: 'global', key: 'g' },
  ]);
});

test('resolvePrecedence: distinct keys all win, nothing shadowed', () => {
  const groups = [
    { scope: 'repo::a/b', error: null, entries: [{ key: 'x' }] },
    { scope: 'global', error: null, entries: [{ key: 'y' }] },
  ];
  const { winningTotal, shadowedTotal } = resolvePrecedence({ groups });
  assert.equal(winningTotal, 2);
  assert.equal(shadowedTotal, 0);
});

test('resolvePrecedence: a read-errored scope passes through with empty entries', () => {
  const groups = [
    { scope: 'repo::a/b', error: 'fetch failed', entries: [] },
    { scope: 'global', error: null, entries: [{ key: 'x' }] },
  ];
  const { groups: out, winningTotal } = resolvePrecedence({ groups });
  assert.equal(out[0].error, 'fetch failed');
  assert.deepEqual(out[0].entries, []);
  assert.equal(out[1].entries[0].winning, true);
  assert.equal(winningTotal, 1);
});

test('resolvePrecedence on empty is empty', () => {
  assert.deepEqual(resolvePrecedence({}), { groups: [], winners: [], winningTotal: 0, shadowedTotal: 0 });
  assert.deepEqual(resolvePrecedence({ groups: [] }), {
    groups: [],
    winners: [],
    winningTotal: 0,
    shadowedTotal: 0,
  });
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

// A git-backed project (remote `acme/widget`, branch `feat/x`) so `deriveScope`
// resolves the full branch → repo → global `readOrder`, with the same key
// `shared` present at all three scopes plus a global-only key.
function seedGitProject() {
  const root = tmp('lk-tree-proj-');
  const home = tmp('lk-tree-home-');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Widget.git');
  git('commit', '--allow-empty', '-m', 'init');
  git('checkout', '-b', 'feat/x');

  const store = path.join(root, '.lorekit');
  const dirs = ['global', 'repo/acme/widget', 'branch/acme/widget/feat/x'];
  for (const d of dirs) fs.mkdirSync(path.join(store, d), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));
  write('global/shared.md', { scope: 'global', key: 'shared', value: 'global body of shared' });
  write('repo/acme/widget/shared.md', { scope: 'repo::acme/widget', key: 'shared', value: 'repo body of shared' });
  write('branch/acme/widget/feat/x/shared.md', {
    scope: 'branch::acme/widget::feat/x',
    key: 'shared',
    value: 'branch body of shared',
  });
  write('global/gonly.md', { scope: 'global', key: 'global-only', value: 'a global-only lesson' });
  return { root, home };
}

// An empty git-backed project — the store dir exists but holds no lessons.
function seedEmpty() {
  const root = tmp('lk-tree-empty-');
  const home = tmp('lk-tree-ehome-');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Widget.git');
  git('commit', '--allow-empty', '-m', 'init');
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

function runTree(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'tree', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

function runTreeAsync(root, home, extraArgs = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'tree', ...extraArgs, '--dir', root], {
      env: baseEnv(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ── integration: precedence resolution ────────────────────────────────────────

test('tree resolves the branch/repo/global hierarchy and marks the winner (exit 0)', () => {
  const { root, home } = seedGitProject();
  const res = runTree(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /resolution tree/);
  // The most-specific scope wins the duplicate `shared` key.
  assert.match(res.stdout, /shadowed by branch::acme\/widget::feat\/x/);
  assert.match(res.stdout, /winning/);
});

test('tree --json tags each entry winning/shadowedBy and lists the winners', () => {
  const { root, home } = seedGitProject();
  const res = runTree(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // project:: is now the most-specific scope in `readOrder` (unified with the
  // read commands' `scopeList`), so it leads; the temp dir's basename varies.
  assert.equal(out.scopes[0].startsWith('project::'), true);
  assert.deepEqual(out.scopes.slice(1), ['branch::acme/widget::feat/x', 'repo::acme/widget', 'global']);
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.winningTotal, 2); // `shared` (branch) + `global-only`
  assert.equal(out.offline.shadowedTotal, 2); // repo + global copies of `shared`
  const winner = out.offline.winners.find((w) => w.key === 'shared');
  assert.equal(winner.scope, 'branch::acme/widget::feat/x');
  // Every scope carries the tagged entries.
  const branchGroup = out.offline.groups.find((g) => g.scope === 'branch::acme/widget::feat/x');
  assert.equal(branchGroup.entries[0].winning, true);
  const globalGroup = out.offline.groups.find((g) => g.scope === 'global');
  const shadowed = globalGroup.entries.find((e) => e.key === 'shared');
  assert.equal(shadowed.winning, false);
  assert.equal(shadowed.shadowedBy, 'branch::acme/widget::feat/x');
});

test('tree now includes project:: scope, and a project lesson wins as most-specific', () => {
  const { root, home } = seedGitProject();
  // Seed a project-scoped copy of `shared` — project is now the most-specific
  // scope in `readOrder`, so it must win over the branch/repo/global copies.
  const projName = path.basename(root).toLowerCase();
  const projScope = `project::${projName}`;
  const projDir = path.join(root, '.lorekit', 'project', projName);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'shared.md'),
    entry({ scope: projScope, key: 'shared', value: 'project body of shared' }),
  );

  const res = runTree(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scopes[0], projScope); // project leads the resolution order
  const winner = out.offline.winners.find((w) => w.key === 'shared');
  assert.equal(winner.scope, projScope); // project beats branch/repo/global
  // The branch copy is now itself shadowed (by project).
  const branchGroup = out.offline.groups.find((g) => g.scope === 'branch::acme/widget::feat/x');
  const branchShared = branchGroup.entries.find((e) => e.key === 'shared');
  assert.equal(branchShared.winning, false);
  assert.equal(branchShared.shadowedBy, projScope);
});

test('tree --scope narrows to one scope (no cross-scope shadowing possible)', () => {
  const { root, home } = seedGitProject();
  const res = runTree(root, home, ['--scope', 'global', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, ['global']);
  assert.equal(out.offline.shadowedTotal, 0);
  assert.equal(out.offline.winningTotal, 2); // both global keys win in isolation
});

test('tree on an empty store reports no lessons (exit 0)', () => {
  const { root, home } = seedEmpty();
  const res = runTree(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.winningTotal, 0);
  assert.deepEqual(out.offline.winners, []);
});

// ── integration: deny-wins suppression ────────────────────────────────────────

test('LOREKIT_DENY=local suppresses the offline resolution', () => {
  const { root, home } = seedGitProject();
  const res = runTree(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

// ── integration: a configured (mock) remote resolved independently ────────────

function startMockRemote(byScope) {
  return http.createServer((req, res) => {
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
}

test('tree resolves a configured remote independently, marking its shadowed keys', async () => {
  const { root, home } = seedGitProject();
  const server = startMockRemote({
    'repo::acme/widget': [{ scope: 'repo::acme/widget', key: 'shared', value: 'remote repo' }],
    global: [{ scope: 'global', key: 'shared', value: 'remote global' }],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runTreeAsync(root, home, ['--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.remote.available, true);
    // repo wins over global for the remote `shared` key (branch has none remote).
    const winner = out.remote.winners.find((w) => w.key === 'shared');
    assert.equal(winner.scope, 'repo::acme/widget');
    assert.equal(out.remote.shadowedTotal, 1);
  } finally {
    server.close();
  }
});
