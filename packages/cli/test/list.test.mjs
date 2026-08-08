// `lorekit list` — lists the lessons for the current dir's scopes, split into an
// Offline (local two-tier store) section and a Remote (hosted MCP) section.
//
// Two layers of coverage:
//   • unit — the pure view helpers (scope set, entry normalization, preview) and
//     the store-agnostic `gather()` against a real local store;
//   • integration — the real binary spawned in a temp project with an isolated
//     HOME and NO remote configured, asserting the offline listing renders and
//     the remote section degrades gracefully (never an error, exit 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scopeList, normalizeEntry, preview, shortDate, gather } from '../src/lessons-view.mjs';
import { remoteUnavailableReason } from '../src/stores.mjs';
import { createLocalStore } from '../src/store/local.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: pure helpers ────────────────────────────────────────────────────────

test('scopeList orders most-specific → broad and de-duplicates', () => {
  const scopes = scopeList({
    projectScope: 'project::widget',
    branchScope: 'branch::acme/widget::feat/x',
    repoScope: 'repo::acme/widget',
  });
  assert.deepEqual(scopes, [
    'project::widget',
    'branch::acme/widget::feat/x',
    'repo::acme/widget',
    'global',
  ]);
});

test('scopeList drops a null branch/repo scope (no git remote) but keeps global', () => {
  assert.deepEqual(scopeList({ projectScope: 'project::x', branchScope: null, repoScope: null }), [
    'project::x',
    'global',
  ]);
  assert.deepEqual(scopeList({}), ['global']);
});

test('normalizeEntry maps updated_at → updated and coerces value/tags', () => {
  const remoteRow = { scope: 'global', key: 'k', value: 42, updated_at: '2026-07-01T00:00:00Z', kind: 'lesson', host: 'reviewer' };
  assert.deepEqual(normalizeEntry(remoteRow), {
    scope: 'global',
    key: 'k',
    value: '42',
    updated: '2026-07-01T00:00:00Z',
    created: null,
    tags: [],
    kind: 'lesson',
    host: 'reviewer',
  });
  // A row without taxonomy columns normalizes them to null.
  assert.deepEqual(
    { kind: normalizeEntry({ scope: 'g', key: 'k' }).kind, host: normalizeEntry({ scope: 'g', key: 'k' }).host },
    { kind: null, host: null },
  );
  // A local row already uses `updated`; a nullish value becomes ''.
  const localRow = { scope: 'global', key: 'k2', value: null, updated: '2026-07-02', tags: ['a'] };
  assert.equal(normalizeEntry(localRow).value, '');
  assert.deepEqual(normalizeEntry(localRow).tags, ['a']);
});

test('preview collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(preview('one\n  two   three'), 'one two three');
  const long = 'x'.repeat(100);
  const out = preview(long, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith('…'));
});

test('shortDate returns the calendar date for an ISO string, else passthrough', () => {
  assert.equal(shortDate('2026-07-22T12:00:00.000Z'), '2026-07-22');
  assert.equal(shortDate('manual'), 'manual');
});

test('remoteUnavailableReason explains each missing piece', () => {
  assert.match(remoteUnavailableReason({ endpoint: null, token: null }), /no endpoint/);
  assert.match(remoteUnavailableReason({ endpoint: 'https://x/<project-ref>/mcp' }), /placeholder/);
  assert.match(remoteUnavailableReason({ endpoint: 'https://x/mcp', token: null }), /no token/);
});

// ── unit: gather() against a real local store ─────────────────────────────────

test('gather collects entries per scope with a total (store-agnostic)', async () => {
  const dir = tmp('lk-list-gather-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'g1', value: 'global lesson' });
  await store.write({ scope: 'repo::acme/widget', key: 'r1', value: 'repo lesson' });

  const { groups, total } = await gather(store, ['repo::acme/widget', 'global']);
  assert.equal(total, 2);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].scope, 'repo::acme/widget');
  assert.equal(groups[0].entries[0].key, 'r1');
  assert.equal(groups[1].entries[0].key, 'g1');
});

test('gather captures a per-scope read failure instead of throwing', async () => {
  const failing = { list: async () => ({ ok: false, networkError: 'fetch failed' }) };
  const { groups, total } = await gather(failing, ['global']);
  assert.equal(total, 0);
  assert.equal(groups[0].error, 'fetch failed');
});

// ── integration: the real binary, no remote configured ────────────────────────

// A project with an opted-in project-tier store (.lorekit/) holding two lessons.
// Seeded under scopes that resolve for ANY directory — `global` and the
// `project::{basename}` derived from the dir name — so the fixture needs no git
// remote to be present (repo/branch scopes are exercised by the manual smoke and
// the git-driven `deriveScope` unit coverage in scope.test-style suites).
function seedProject() {
  const root = tmp('lk-list-proj-');
  const home = tmp('lk-list-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  fs.writeFileSync(
    path.join(store, 'global', 'a.md'),
    entry({ scope: 'global', key: 'prefer-guard-clauses', value: 'Use early returns.' }),
  );
  fs.writeFileSync(
    path.join(store, 'project', projectName, 'b.md'),
    entry({ scope: `project::${projectName}`, key: 'widget-build-flags', value: 'Needs --no-sandbox.' }),
  );
  return { root, home };
}

function entry({ scope, key, value }) {
  const fm = {
    scope,
    key,
    tags: [],
    source_agent: 'aw',
    trigger: 'manual',
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at: null,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${value}\n`;
}

// Run the binary with remote config stripped from the environment, so the remote
// section is guaranteed unavailable regardless of the developer's own env.
function runList(root, home, extraArgs = [], extraEnv = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    LOREKIT_HOME: home,
    LOREKIT_TELEMETRY: '0',
    ...extraEnv,
  };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  const command = extraArgs[0] === 'ls' ? extraArgs : ['list', ...extraArgs];
  return spawnSync(process.execPath, [BIN, ...command, '--dir', root], {
    encoding: 'utf8',
    env,
  });
}

test('list renders the offline section and degrades remote gracefully (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runList(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Offline/);
  // Keys are shown as scope::key so they can be copy-pasted directly into show/write.
  assert.match(res.stdout, /global::prefer-guard-clauses/);
  assert.match(res.stdout, /widget-build-flags/); // project::... prefix in there
  // Remote is not configured → a graceful note, never an error line.
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

test('list --json emits normalized offline groups and remote.available=false', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.total, 2);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /token|endpoint/);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.ok(keys.includes('widget-build-flags'));
  assert.ok(keys.includes('prefer-guard-clauses'));
});

test('list --scope narrows to a single scope', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--scope', 'global', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, ['global']);
  assert.equal(out.offline.total, 1);
  assert.equal(out.offline.groups[0].entries[0].key, 'prefer-guard-clauses');
});

test('the `ls` alias resolves to `list`', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['ls', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.total, 2);
});

test('LOREKIT_DENY=remote suppresses the remote section (deny-wins), offline still lists', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--json'], { LOREKIT_DENY: 'remote' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /deny constraint/);
  assert.equal(out.offline.total, 2);
});

test('LOREKIT_DENY=local suppresses the offline section', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});
