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

import { scopeList, normalizeEntry, preview, shortDate, gather, matchesTags, matchesScalar, entryFilter } from '../src/shared/lessons-view.mjs';
import { remoteUnavailableReason } from '../src/shared/stores.mjs';
import { parseReadFilters } from '../src/shared/flags.mjs';
import { createLocalStore } from '../src/store/local.mjs';
import { createRemoteStore } from '../src/store/remote.mjs';

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
    source_agent: null,
    trigger: null,
    origin_repo: null,
    origin_branch: null,
    origin_pr: null,
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

// ── unit: the --tags / --kind / --host filters ────────────────────────────────

test('matchesTags applies the hosted any/all/none semantics', () => {
  const tags = ['perf', 'ci'];
  assert.equal(matchesTags(tags, ['perf', 'auth'], 'any'), true);
  assert.equal(matchesTags(tags, ['auth'], 'any'), false);
  assert.equal(matchesTags(tags, ['perf', 'ci'], 'all'), true);
  assert.equal(matchesTags(tags, ['perf', 'auth'], 'all'), false);
  assert.equal(matchesTags(tags, ['auth'], 'none'), true);
  assert.equal(matchesTags(tags, ['perf'], 'none'), false);
  // `any` is the default, an empty wanted list matches everything, and an
  // untagged entry never satisfies `any`/`all`.
  assert.equal(matchesTags(tags, ['ci']), true);
  assert.equal(matchesTags(tags, []), true);
  assert.equal(matchesTags(undefined, ['perf'], 'any'), false);
});

test('matchesScalar applies the hosted in/nin rule, excluding unset values from both', () => {
  const wanted = new Set(['bus', 'signal']);
  assert.equal(matchesScalar('bus', wanted, 'in'), true);
  assert.equal(matchesScalar('lesson', wanted, 'in'), false);
  assert.equal(matchesScalar('lesson', wanted, 'nin'), true);
  assert.equal(matchesScalar('bus', wanted, 'nin'), false);
  // `lorekit_match_text` (migration 00066): a row with no value matches neither.
  assert.equal(matchesScalar(null, wanted, 'in'), false);
  assert.equal(matchesScalar(null, wanted, 'nin'), false);
  // `in` is the default; no filter matches everything, unset values included.
  assert.equal(matchesScalar('bus', wanted), true);
  assert.equal(matchesScalar(null, null, 'nin'), true);
});

test('entryFilter combines kind, host and tags with AND', () => {
  const keep = entryFilter({ kind: 'lesson', tags: ['perf'], tags_mode: 'any' });
  assert.equal(keep({ kind: 'lesson', host: null, tags: ['perf'] }), true);
  assert.equal(keep({ kind: 'bus', host: null, tags: ['perf'] }), false);
  assert.equal(keep({ kind: 'lesson', host: null, tags: ['ci'] }), false);
  // No filters → keeps everything.
  assert.equal(entryFilter({})({ kind: null, host: null, tags: [] }), true);
});

test('entryFilter negates kind and host independently with nin', () => {
  const keep = entryFilter({ kind: ['bus'], kind_mode: 'nin', host: ['ci', 'review'], host_mode: 'nin' });
  assert.equal(keep({ kind: 'lesson', host: 'reviewer', tags: [] }), true);
  assert.equal(keep({ kind: 'bus', host: 'reviewer', tags: [] }), false);
  assert.equal(keep({ kind: 'lesson', host: 'ci', tags: [] }), false);
  assert.equal(keep({ kind: null, host: 'reviewer', tags: [] }), false);

  const mixed = entryFilter({ kind: ['lesson'], kind_mode: 'in', host: ['ci'], host_mode: 'nin' });
  assert.equal(mixed({ kind: 'lesson', host: 'aw', tags: [] }), true);
  assert.equal(mixed({ kind: 'lesson', host: 'ci', tags: [] }), false);
});

test('entryFilter applies source_agent, trigger and origin_* with the same in/nin rule', () => {
  const row = { tags: [], source_agent: 'claude', trigger: 'stuck-loop', origin_repo: 'acme/widget', origin_branch: 'main', origin_pr: 7 };
  assert.equal(entryFilter({ source_agent: ['claude'] })(row), true);
  assert.equal(entryFilter({ source_agent: ['claude'], source_agent_mode: 'nin' })(row), false);
  assert.equal(entryFilter({ trigger: ['manual'], trigger_mode: 'nin' })(row), true);
  assert.equal(entryFilter({ origin_repo: ['acme/widget'], origin_branch: ['feat/x'] })(row), false);
  // origin_pr compares numerically, whatever type either side holds.
  assert.equal(entryFilter({ origin_pr: ['007'] })(row), true);
  assert.equal(entryFilter({ origin_pr: ['7'] })({ ...row, origin_pr: '7' }), true);
  assert.equal(entryFilter({ origin_pr: ['8'], origin_pr_mode: 'nin' })(row), true);
  // A row with no provenance matches neither mode, as on the server.
  assert.equal(entryFilter({ origin_pr: ['8'], origin_pr_mode: 'nin' })({ ...row, origin_pr: null }), false);
});

test('parseReadFilters defaults each mode, validates it, and refuses a silent no-op', () => {
  assert.deepEqual(parseReadFilters({}), { filters: {} });
  assert.deepEqual(parseReadFilters({ tags: ' perf, ci ,perf' }), {
    filters: { tags: ['perf', 'ci'], tags_mode: 'any' },
  });
  assert.deepEqual(parseReadFilters({ tags: 'perf', 'tags-mode': 'none' }), {
    filters: { tags: ['perf'], tags_mode: 'none' },
  });
  assert.deepEqual(parseReadFilters({ kind: 'lesson,bus', host: 'ci', 'host-mode': 'nin' }), {
    filters: { kind: ['lesson', 'bus'], kind_mode: 'in', host: ['ci'], host_mode: 'nin' },
  });
  assert.match(parseReadFilters({ tags: 'perf', 'tags-mode': 'some' }).error, /--tags-mode must be one of any\|all\|none/);
  assert.match(parseReadFilters({ tags: true }).error, /--tags needs a comma-separated list/);
  assert.match(parseReadFilters({ tags: ' , ' }).error, /--tags needs a comma-separated list/);
  assert.match(parseReadFilters({ 'tags-mode': 'all' }).error, /--tags-mode needs --tags/);
  // kind/host accept only in|nin — `all` is a tags-only mode.
  assert.match(parseReadFilters({ kind: 'bus', 'kind-mode': 'all' }).error, /--kind-mode must be one of in\|nin/);
  assert.match(parseReadFilters({ host: 'ci', 'host-mode': 'none' }).error, /--host-mode must be one of in\|nin/);
  assert.match(parseReadFilters({ 'kind-mode': 'nin' }).error, /--kind-mode needs --kind/);
  assert.match(parseReadFilters({ 'host-mode': 'in' }).error, /--host-mode needs --host/);
  assert.match(parseReadFilters({ kind: true }).error, /--kind needs a comma-separated list/);
});

test('parseReadFilters covers the provenance and attribution dimensions policy takes', () => {
  assert.deepEqual(
    parseReadFilters({
      'source-agent': 'claude', 'source-agent-mode': 'nin',
      trigger: 'stuck-loop,manual',
      'origin-repo': 'mthines/lorekit',
      'origin-branch': 'main', 'origin-branch-mode': 'nin',
      'origin-pr': '#482, 007,482',
    }),
    {
      filters: {
        source_agent: ['claude'], source_agent_mode: 'nin',
        trigger: ['stuck-loop', 'manual'], trigger_mode: 'in',
        origin_repo: ['mthines/lorekit'], origin_repo_mode: 'in',
        origin_branch: ['main'], origin_branch_mode: 'nin',
        // `#` stripped, `007` read as 7, the repeat de-duplicated.
        origin_pr: ['482', '7'], origin_pr_mode: 'in',
      },
    },
  );
  // A non-numeric PR would be DROPPED by the hosted route, which then applies no
  // PR filter at all — so it is refused here instead of listing everything.
  assert.match(parseReadFilters({ 'origin-pr': '482,abc' }).error, /--origin-pr takes pull request numbers.*"abc"/);
  assert.match(parseReadFilters({ 'trigger-mode': 'nin' }).error, /--trigger-mode needs --trigger/);
  assert.match(parseReadFilters({ 'origin-repo': 'a/b', 'origin-repo-mode': 'any' }).error, /--origin-repo-mode must be one of in\|nin/);
});

test('gather narrows a local store by tags under each mode', async () => {
  const dir = tmp('lk-list-tags-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'both', value: 'v', tags: ['perf', 'ci'] });
  await store.write({ scope: 'global', key: 'perf-only', value: 'v', tags: ['perf'] });
  await store.write({ scope: 'global', key: 'untagged', value: 'v' });

  const keys = async (filters) =>
    (await gather(store, ['global'], filters)).groups[0].entries.map((e) => e.key).sort();

  assert.deepEqual(await keys({ tags: ['perf', 'ci'], tags_mode: 'any' }), ['both', 'perf-only']);
  assert.deepEqual(await keys({ tags: ['perf', 'ci'], tags_mode: 'all' }), ['both']);
  assert.deepEqual(await keys({ tags: ['ci'], tags_mode: 'none' }), ['perf-only', 'untagged']);
});

test('the local store keeps requiring every tag when no mode is given', async () => {
  // `search()` and other existing callers pass `tags` alone and rely on AND.
  const dir = tmp('lk-list-tags-default-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'both', value: 'v', tags: ['perf', 'ci'] });
  await store.write({ scope: 'global', key: 'perf-only', value: 'v', tags: ['perf'] });
  const { entries } = await store.list({ scope: 'global', tags: ['perf', 'ci'] });
  assert.deepEqual(entries.map((e) => e.key), ['both']);
});

test('RemoteStore.list forwards tags and tags_mode to GET /memories', async () => {
  const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_ro_x' });
  const seen = [];
  store._rest = async (p) => { seen.push(p); return { ok: true, data: { entries: [] } }; };

  await store.list({ scope: 'global', tags: ['perf', 'ci'], tags_mode: 'none' });
  const params = new URL(seen[0], 'https://x').searchParams;
  assert.equal(params.get('tags'), 'perf,ci');
  assert.equal(params.get('tags_mode'), 'none');

  // A mode without tags is meaningless, so it is not sent.
  await store.list({ scope: 'global', tags_mode: 'all' });
  assert.equal(new URL(seen[1], 'https://x').searchParams.has('tags_mode'), false);
});

test('RemoteStore.list forwards kind_mode and host_mode only with their dimension', async () => {
  const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_ro_x' });
  const seen = [];
  store._rest = async (p) => { seen.push(p); return { ok: true, data: { entries: [] } }; };

  await store.list({ scope: 'global', kind: ['bus', 'signal'], kind_mode: 'nin', host: ['ci'], host_mode: 'in' });
  const params = new URL(seen[0], 'https://x').searchParams;
  assert.equal(params.get('kind'), 'bus,signal');
  assert.equal(params.get('kind_mode'), 'nin');
  assert.equal(params.get('host'), 'ci');
  assert.equal(params.get('host_mode'), 'in');

  await store.list({ scope: 'global', kind_mode: 'nin', host_mode: 'nin', kind: [] });
  const bare = new URL(seen[1], 'https://x').searchParams;
  for (const key of ['kind', 'kind_mode', 'host', 'host_mode']) assert.equal(bare.has(key), false, key);
});

test('RemoteStore.list forwards the attribution and provenance dimensions', async () => {
  const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_ro_x' });
  const seen = [];
  store._rest = async (p) => { seen.push(p); return { ok: true, data: { entries: [] } }; };

  await store.list({
    scope: 'global',
    source_agent: ['claude', 'aw'], source_agent_mode: 'nin',
    trigger: ['stuck-loop'],
    origin_repo: ['mthines/lorekit'],
    origin_branch: ['main'], origin_branch_mode: 'nin',
    origin_pr: ['482'], origin_pr_mode: 'in',
    owner: ['personal'], // not a list() dimension — must not leak onto the wire
  });
  const params = new URL(seen[0], 'https://x').searchParams;
  assert.equal(params.get('source_agent'), 'claude,aw');
  assert.equal(params.get('source_agent_mode'), 'nin');
  assert.equal(params.get('trigger'), 'stuck-loop');
  assert.equal(params.has('trigger_mode'), false);
  assert.equal(params.get('origin_repo'), 'mthines/lorekit');
  assert.equal(params.get('origin_branch_mode'), 'nin');
  assert.equal(params.get('origin_pr'), '482');
  assert.equal(params.has('owner'), false);
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
    entry({
      scope: 'global', key: 'prefer-guard-clauses', value: 'Use early returns.', tags: ['style'],
      kind: 'lesson', host: 'reviewer', source_agent: 'claude', origin_repo: 'acme/widget', origin_pr: 482,
    }),
  );
  fs.writeFileSync(
    path.join(store, 'project', projectName, 'b.md'),
    entry({
      scope: `project::${projectName}`, key: 'widget-build-flags', value: 'Needs --no-sandbox.',
      kind: 'bus', host: 'ci', trigger: 'stuck-loop', origin_branch: 'main',
    }),
  );
  return { root, home };
}

function entry({ scope, key, value, tags = [], kind, host, ...overrides }) {
  const fm = {
    scope,
    key,
    tags,
    ...(kind ? { kind } : {}),
    ...(host ? { host } : {}),
    source_agent: 'aw',
    trigger: 'manual',
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at: null,
    ...overrides,
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

test('list --tags narrows both sections to tagged memories (default any)', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--tags', 'style,perf', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.deepEqual(keys, ['prefer-guard-clauses']);
  assert.equal(out.offline.total, 1);
});

test('list --tags-mode none excludes the tagged memory', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--tags', 'style', '--tags-mode', 'none', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.deepEqual(keys, ['widget-build-flags']);
});

test('list rejects an invalid --tags-mode and a bare --tags instead of listing everything', () => {
  const { root, home } = seedProject();
  const badMode = runList(root, home, ['--tags', 'style', '--tags-mode', 'some']);
  assert.notEqual(badMode.status, 0);
  assert.match(badMode.stderr, /--tags-mode must be one of any\|all\|none/);

  const bare = runList(root, home, ['--tags', '--json']);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /--tags needs a comma-separated list/);
});

test('list --kind / --host narrow, and --kind-mode / --host-mode nin negate', () => {
  const { root, home } = seedProject();
  const keysFor = (args) => {
    const res = runList(root, home, [...args, '--json']);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  };
  assert.deepEqual(keysFor(['--kind', 'bus']), ['widget-build-flags']);
  assert.deepEqual(keysFor(['--kind', 'bus', '--kind-mode', 'nin']), ['prefer-guard-clauses']);
  assert.deepEqual(keysFor(['--host', 'ci,reviewer', '--host-mode', 'nin']), []);
  assert.deepEqual(keysFor(['--kind', 'lesson', '--host', 'ci', '--host-mode', 'nin']), ['prefer-guard-clauses']);
});

test('list rejects a tags-only mode on --kind-mode and a mode without its flag', () => {
  const { root, home } = seedProject();
  const badMode = runList(root, home, ['--kind', 'bus', '--kind-mode', 'all']);
  assert.notEqual(badMode.status, 0);
  assert.match(badMode.stderr, /--kind-mode must be one of in\|nin/);

  const orphan = runList(root, home, ['--host-mode', 'nin']);
  assert.notEqual(orphan.status, 0);
  assert.match(orphan.stderr, /--host-mode needs --host/);
});

test('list filters by source agent, trigger and provenance, with nin', () => {
  const { root, home } = seedProject();
  const keysFor = (args) => {
    const res = runList(root, home, [...args, '--json']);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  };
  assert.deepEqual(keysFor(['--source-agent', 'claude']), ['prefer-guard-clauses']);
  assert.deepEqual(keysFor(['--source-agent', 'claude', '--source-agent-mode', 'nin']), ['widget-build-flags']);
  assert.deepEqual(keysFor(['--trigger', 'stuck-loop']), ['widget-build-flags']);
  assert.deepEqual(keysFor(['--origin-repo', 'acme/widget']), ['prefer-guard-clauses']);
  assert.deepEqual(keysFor(['--origin-pr', '#482']), ['prefer-guard-clauses']);
  // `nin` needs a set value: the row with no branch matches neither mode.
  assert.deepEqual(keysFor(['--origin-branch', 'feat/x', '--origin-branch-mode', 'nin']), ['widget-build-flags']);
});

test('list refuses a non-numeric --origin-pr instead of listing everything', () => {
  const { root, home } = seedProject();
  const res = runList(root, home, ['--origin-pr', 'abc']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--origin-pr takes pull request numbers/);
});
