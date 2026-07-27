// `lorekit scopes` — a STORE-WIDE inventory of every distinct scope that holds
// lessons, with a per-scope lesson count, in the same Offline / Remote split as
// the other read commands.
//
// Two layers of coverage:
//   • unit — the pure inventory helpers (`scopeTypeOf`, `sortScopeInventory`,
//     `filterScopeInventory`, `summarizeScopeInventory`): type ordering, the
//     substring filter, and totalling;
//   • integration — the real binary spawned in a temp project with an isolated
//     HOME, asserting the load-bearing full-inventory behaviour (scopes that do
//     NOT resolve for the cwd are still listed, with correct counts), `--json`,
//     the substring `--scope` filter, an empty store, deny suppression, and the
//     HONEST remote note — both unconfigured AND configured-but-not-enumerable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scopeTypeOf,
  sortScopeInventory,
  filterScopeInventory,
  summarizeScopeInventory,
} from '../src/lessons-view.mjs';
import { REMOTE_SCOPES_UNSUPPORTED } from '../src/scopes.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: the pure inventory helpers ──────────────────────────────────────────

test('scopeTypeOf classifies each scope type, unknown → other', () => {
  assert.equal(scopeTypeOf('global'), 'global');
  assert.equal(scopeTypeOf('project::widget'), 'project');
  assert.equal(scopeTypeOf('repo::a/b'), 'repo');
  assert.equal(scopeTypeOf('branch::a/b::main'), 'branch');
  assert.equal(scopeTypeOf('bogus::x'), 'other');
  assert.equal(scopeTypeOf(''), 'other');
  assert.equal(scopeTypeOf(null), 'other');
});

test('sortScopeInventory orders by type (global→project→repo→branch→other) then name', () => {
  const sorted = sortScopeInventory([
    { scope: 'repo::z/z', count: 1 },
    { scope: 'branch::a/b::main', count: 1 },
    { scope: 'project::beta', count: 1 },
    { scope: 'global', count: 1 },
    { scope: 'project::alpha', count: 1 },
    { scope: 'repo::a/a', count: 1 },
    { scope: 'weird::x', count: 1 },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.scope),
    [
      'global',
      'project::alpha',
      'project::beta',
      'repo::a/a',
      'repo::z/z',
      'branch::a/b::main',
      'weird::x',
    ],
  );
});

test('sortScopeInventory does not mutate its input', () => {
  const input = [
    { scope: 'repo::a/b', count: 1 },
    { scope: 'global', count: 1 },
  ];
  const before = input.map((s) => s.scope);
  sortScopeInventory(input);
  assert.deepEqual(input.map((s) => s.scope), before);
});

test('filterScopeInventory keeps only scopes containing the substring (case-insensitive)', () => {
  const list = [
    { scope: 'global', count: 1 },
    { scope: 'repo::acme/web', count: 2 },
    { scope: 'repo::acme/api', count: 3 },
    { scope: 'branch::acme/web::main', count: 1 },
  ];
  assert.deepEqual(
    filterScopeInventory(list, 'repo::').map((s) => s.scope),
    ['repo::acme/web', 'repo::acme/api'],
  );
  assert.deepEqual(
    filterScopeInventory(list, 'WEB').map((s) => s.scope),
    ['repo::acme/web', 'branch::acme/web::main'],
  );
  // An empty / absent needle passes everything through unchanged.
  assert.equal(filterScopeInventory(list, '').length, 4);
  assert.equal(filterScopeInventory(list, null).length, 4);
});

test('summarizeScopeInventory sorts and totals the counts', () => {
  const { scopes, total } = summarizeScopeInventory([
    { scope: 'repo::a/b', count: 2 },
    { scope: 'global', count: 3 },
  ]);
  assert.equal(total, 5);
  assert.deepEqual(scopes.map((s) => s.scope), ['global', 'repo::a/b']);
});

test('summarizeScopeInventory on an empty list is zero everywhere', () => {
  assert.deepEqual(summarizeScopeInventory([]), { scopes: [], total: 0 });
  assert.deepEqual(summarizeScopeInventory(), { scopes: [], total: 0 });
});

// ── integration fixtures ──────────────────────────────────────────────────────

function entry({ scope, key, value, tags = [], archived_at = null }) {
  const fm = {
    scope,
    key,
    tags,
    source_agent: 'aw',
    trigger: 'manual',
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${value}\n`;
}

// Seed a HOME-tier store with lessons across MULTIPLE distinct scopes that do
// NOT resolve for the test's cwd — an unrelated repo, branch, and project, plus
// global. This is the load-bearing setup: `scopes` must surface ALL of them
// regardless of the current directory (whereas `list`/`stats` would only ever
// show the cwd's project::<basename> + global). Includes one archived lesson to
// prove archived entries are excluded from the counts.
function seedStore() {
  const root = tmp('lk-scopes-root-');
  const home = tmp('lk-scopes-home-');
  const write = (rel, e) => {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry(e));
  };
  write('repo/other/thing/k1.md', { scope: 'repo::other/thing', key: 'k1', value: 'first' });
  write('repo/other/thing/k2.md', { scope: 'repo::other/thing', key: 'k2', value: 'second' });
  write('branch/x/y/z.md', { scope: 'branch::x/y::z', key: 'k3', value: 'third' });
  write('project/somethingelse/k4.md', {
    scope: 'project::somethingelse',
    key: 'k4',
    value: 'fourth',
  });
  write('global/k5.md', { scope: 'global', key: 'k5', value: 'fifth' });
  // Archived → must NOT be counted.
  write('global/k6.md', { scope: 'global', key: 'k6', value: 'gone', archived_at: '2026-07-21T00:00:00.000Z' });
  return { root, home };
}

// An empty store — HOME exists but holds no lessons.
function seedEmpty() {
  const root = tmp('lk-scopes-eroot-');
  const home = tmp('lk-scopes-ehome-');
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

// Seed BOTH tiers so the project tier is active (its `.lorekit` dir exists) with
// an OVERLAPPING `scope::key` present in home AND project, plus a home-only and a
// project-only key. This is the load-bearing fixture for the cross-tier dedup:
// `TwoTierStore.listScopes()` must count a `scope::key` present in both tiers
// ONCE (project shadows home, the same first-wins merge `list` uses).
function seedTwoTier() {
  const root = tmp('lk-scopes-2root-');
  const home = tmp('lk-scopes-2home-');
  const project = path.join(root, '.lorekit'); // default project-tier dir
  const writeTier = (base, rel, e) => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry(e));
  };
  // Same scope::key in BOTH tiers → must be counted exactly once.
  writeTier(home, 'global/dup.md', { scope: 'global', key: 'dup', value: 'home copy' });
  writeTier(project, 'global/dup.md', { scope: 'global', key: 'dup', value: 'project copy' });
  // A home-only and a project-only key → both counted.
  writeTier(home, 'global/home-only.md', { scope: 'global', key: 'homeonly', value: 'h' });
  writeTier(project, 'project/thing/p.md', { scope: 'project::thing', key: 'ponly', value: 'p' });
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

function runScopes(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'scopes', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

// Async variant for tests that boot an in-process mock HTTP server (spawnSync
// would block the event loop and the mock could never answer the child).
function runScopesAsync(root, home, extraArgs = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'scopes', ...extraArgs, '--dir', root], {
      env: baseEnv(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ── integration: the load-bearing full-inventory behaviour ────────────────────

test('scopes lists EVERY distinct scope store-wide, not just the cwd’s (--json)', () => {
  const { root, home } = seedStore();
  const res = runScopes(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, true);

  const byScope = Object.fromEntries(out.offline.scopes.map((s) => [s.scope, s.count]));
  // All four seeded scopes appear — including the three that do NOT resolve for
  // the cwd (an unrelated repo/branch/project). This is what distinguishes a
  // store-wide inventory from the cwd-scoped `list`/`stats`.
  assert.equal(byScope['repo::other/thing'], 2);
  assert.equal(byScope['branch::x/y::z'], 1);
  assert.equal(byScope['project::somethingelse'], 1);
  assert.equal(byScope['global'], 1); // archived k6 excluded → 1, not 2
  // Grand total excludes the archived entry.
  assert.equal(out.offline.total, 5);
  assert.equal(out.offline.scopes.length, 4);
});

test('scopes surfaces a scope that is NOT applicable to the current directory', () => {
  const { root, home } = seedStore();
  // Human output (no --json) must name the unrelated repo/branch/project scopes.
  const res = runScopes(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /repo::other\/thing/);
  assert.match(res.stdout, /branch::x\/y::z/);
  assert.match(res.stdout, /project::somethingelse/);
  assert.match(res.stdout, /Offline/);
  assert.match(res.stdout, /total/);
});

// ── integration: cross-tier dedup (project shadows home) ──────────────────────

test('scopes counts a scope::key present in BOTH tiers once (project shadows home)', () => {
  const { root, home } = seedTwoTier();
  const res = runScopes(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const byScope = Object.fromEntries(out.offline.scopes.map((s) => [s.scope, s.count]));
  // global holds `dup` (in both tiers → counted once) + `homeonly` → 2, not 3.
  assert.equal(byScope['global'], 2);
  assert.equal(byScope['project::thing'], 1);
  // Total is 3, not 4 — the overlapping `global::dup` is never double-counted.
  assert.equal(out.offline.total, 3);
});

// ── integration: --scope substring filter ─────────────────────────────────────

test('scopes --scope filters the inventory to matching scopes (substring)', () => {
  const { root, home } = seedStore();
  const res = runScopes(root, home, ['--scope', 'repo::', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.filter, 'repo::');
  assert.deepEqual(out.offline.scopes.map((s) => s.scope), ['repo::other/thing']);
  assert.equal(out.offline.total, 2);
});

// ── integration: empty store ──────────────────────────────────────────────────

test('scopes on an empty store reports zero scopes (exit 0)', () => {
  const { root, home } = seedEmpty();
  const res = runScopes(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.total, 0);
  assert.deepEqual(out.offline.scopes, []);
});

test('scopes on an empty store prints a graceful human note', () => {
  const { root, home } = seedEmpty();
  const res = runScopes(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no scopes found/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

// ── integration: deny-wins suppression ────────────────────────────────────────

test('LOREKIT_DENY=local suppresses the offline inventory', () => {
  const { root, home } = seedStore();
  const res = runScopes(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

test('LOREKIT_DENY=remote suppresses the remote note; offline still enumerates', () => {
  const { root, home } = seedStore();
  const res = runScopes(root, home, ['--json'], { LOREKIT_DENY: 'remote' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /deny constraint/);
  assert.equal(out.offline.total, 5);
});

// ── integration: the HONEST remote note ───────────────────────────────────────

test('scopes degrades an unconfigured remote to a note, never an error', () => {
  const { root, home } = seedStore();
  const res = runScopes(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.remote.available, false);
  // No endpoint/token configured → the connectivity note (not the capability one).
  assert.match(out.remote.reason, /endpoint|token/);
});

// A configured (usable) remote STILL can't enumerate scopes — the hosted MCP
// surface has no "list all scopes" tool. This asserts the honest capability
// note, NOT a faked inventory. A mock server is booted only to make the remote
// `usable()`; `scopes` never actually calls it for enumeration.
test('scopes reports the honest not-enumerable note even for a CONFIGURED remote', async () => {
  const { root, home } = seedStore();
  const server = http.createServer((req, res) => {
    // Should never be hit for enumeration, but answer defensively if it is.
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runScopesAsync(root, home, ['--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.remote.available, false);
    assert.equal(out.remote.reason, REMOTE_SCOPES_UNSUPPORTED);
    assert.match(out.remote.reason, /not supported by the hosted MCP surface/);
    // Offline is enumerated independently and is unaffected.
    assert.equal(out.offline.total, 5);
  } finally {
    server.close();
  }
});
