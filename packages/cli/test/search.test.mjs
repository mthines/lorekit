// `lorekit search <query>` — full-text search the applicable lessons across both
// stores, rendered in the same Offline / Remote split as `list`.
//
// Two layers of coverage:
//   • unit — the pure matcher (`matchesQuery`) and the gather-filter
//     (`filterGroups`) that give search one deterministic, literal-substring
//     behaviour across both stores;
//   • integration — the real binary spawned in a temp project with an isolated
//     HOME, asserting offline matching, case-insensitivity, key-vs-value hits,
//     literal (non-regex) matching, `--scope`, `--json`, deny suppression, the
//     alias, a mock remote match, and graceful remote degradation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesQuery, filterGroups } from '../src/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: matchesQuery (the pure, literal, case-insensitive matcher) ──────────

test('matchesQuery hits on the key or the value, case-insensitively', () => {
  const e = { key: 'build-flags', value: 'Needs --no-sandbox to build.' };
  assert.equal(matchesQuery(e, 'build'), true); // in key AND value
  assert.equal(matchesQuery(e, 'sandbox'), true); // value only
  assert.equal(matchesQuery(e, 'FLAGS'), true); // key, upper-cased query
  assert.equal(matchesQuery(e, 'SANDBOX'), true); // value, upper-cased query
  assert.equal(matchesQuery(e, 'nomatch'), false);
});

test('matchesQuery treats regex metacharacters literally (no injection)', () => {
  const literal = { key: 'regex-note', value: 'Escape a.*(b) in queries.' };
  assert.equal(matchesQuery(literal, 'a.*(b)'), true); // exact substring present
  // A plain value must NOT match a regex-y query — proving it is not compiled.
  const plain = { key: 'k', value: 'aXXXb' };
  assert.equal(matchesQuery(plain, 'a.*b'), false); // would match if regex
});

test('matchesQuery: an empty query matches everything, missing fields are safe', () => {
  assert.equal(matchesQuery({ key: 'k', value: 'v' }, ''), true);
  assert.equal(matchesQuery({}, 'x'), false);
  assert.equal(matchesQuery({ key: null, value: null }, 'x'), false);
});

// ── unit: filterGroups (filter gather() output, recompute total, keep errors) ─

test('filterGroups keeps only matching entries and recomputes the total', () => {
  const gathered = {
    groups: [
      {
        scope: 'global',
        error: null,
        entries: [
          { key: 'a', value: 'has build word' },
          { key: 'b', value: 'nothing here' },
        ],
      },
      { scope: 'project::x', error: null, entries: [{ key: 'build-c', value: 'zzz' }] },
    ],
  };
  const { groups, total } = filterGroups(gathered, 'build');
  assert.equal(total, 2);
  assert.deepEqual(groups[0].entries.map((e) => e.key), ['a']);
  assert.deepEqual(groups[1].entries.map((e) => e.key), ['build-c']);
});

test('filterGroups preserves a per-scope read error and never counts it', () => {
  const gathered = { groups: [{ scope: 'global', error: 'fetch failed', entries: [] }] };
  const { groups, total } = filterGroups(gathered, 'anything');
  assert.equal(total, 0);
  assert.equal(groups[0].error, 'fetch failed');
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

// A project with an opted-in project-tier store holding four lessons under the
// two scopes that resolve for ANY directory (global + project::{basename}), so
// no git remote is needed.
function seedProject() {
  const root = tmp('lk-search-proj-');
  const home = tmp('lk-search-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));

  write('global/a.md', {
    scope: 'global',
    key: 'prefer-guard-clauses',
    value: 'Use early returns to reduce nesting.',
    tags: ['style'],
  });
  write('global/b.md', {
    scope: 'global',
    key: 'build-cache-tip',
    value: 'The build cache is flaky on CI.',
  });
  write(`project/${projectName}/c.md`, {
    scope: `project::${projectName}`,
    key: 'widget-build-flags',
    value: 'Needs --no-sandbox to build.',
  });
  write(`project/${projectName}/d.md`, {
    scope: `project::${projectName}`,
    key: 'regex-note',
    value: 'Escape a.*(b) in queries.',
  });
  return { root, home, projectName };
}

// Run the binary with remote config stripped (unless `extraEnv` re-adds it), so
// the remote section is deterministic regardless of the developer's own env.
function runSearch(root, home, extraArgs = [], extraEnv = {}) {
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
  const command = extraArgs[0] === 'grep' ? extraArgs : ['search', ...extraArgs];
  return spawnSync(process.execPath, [BIN, ...command, '--dir', root], {
    encoding: 'utf8',
    env,
  });
}

// Async variant — required whenever a test runs an in-process mock HTTP server:
// spawnSync would block THIS process's event loop, so the mock could never
// answer the child's fetch. spawn keeps the loop free to serve it.
function runSearchAsync(root, home, extraArgs = [], extraEnv = {}) {
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
  const command = extraArgs[0] === 'grep' ? extraArgs : ['search', ...extraArgs];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...command, '--dir', root], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ── integration: offline matching ─────────────────────────────────────────────

test('search matches offline and degrades remote gracefully (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['sandbox']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Offline/);
  assert.match(res.stdout, /widget-build-flags/);
  // Only the matching lesson shows — not the unrelated guard-clauses one.
  assert.doesNotMatch(res.stdout, /prefer-guard-clauses/);
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

test('search with no matches prints a friendly note (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['zzznomatch']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no lessons match/);
});

test('search is case-insensitive', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['SANDBOX', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.total, 1);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.deepEqual(keys, ['widget-build-flags']);
});

test('search matches on the key alone', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['guard', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.deepEqual(keys, ['prefer-guard-clauses']); // 'guard' is only in the key
  assert.equal(out.offline.total, 1);
});

test('search matches on the value alone', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['nesting', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.deepEqual(keys, ['prefer-guard-clauses']); // 'nesting' is only in the value
});

test('search treats a regex-metacharacter query literally', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['a.*(b)', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  // Only the lesson whose value literally contains "a.*(b)" — never a regex sweep.
  assert.deepEqual(keys, ['regex-note']);
  assert.equal(out.offline.total, 1);
});

test('search finds multiple matches across scopes', () => {
  const { root, home, projectName } = seedProject();
  const res = runSearch(root, home, ['build', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.total, 2); // build-cache-tip (global) + widget-build-flags (project)
  const byScope = Object.fromEntries(
    out.offline.groups.map((g) => [g.scope, g.entries.map((e) => e.key)]),
  );
  assert.deepEqual(byScope['global'], ['build-cache-tip']);
  assert.deepEqual(byScope[`project::${projectName}`], ['widget-build-flags']);
});

test('search --json emits { query, offline, remote } with remote.available=false', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['build', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.query, 'build');
  assert.equal(out.offline.available, true);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /token|endpoint/);
});

test('search --scope narrows to a single scope', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['build', '--scope', 'global', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, ['global']);
  assert.equal(out.offline.total, 1);
  const keys = out.offline.groups.flatMap((g) => g.entries.map((e) => e.key));
  assert.deepEqual(keys, ['build-cache-tip']); // the project match is out of scope
});

test('the `grep` alias resolves to `search`', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['grep', 'sandbox', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.query, 'sandbox');
  assert.equal(out.offline.total, 1);
});

test('an empty/missing query is a usage error (non-zero exit)', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
  assert.match(res.stderr, /search <query>/);
});

// ── integration: deny-wins suppression ────────────────────────────────────────

test('LOREKIT_DENY=local suppresses the offline section', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['build', '--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

test('LOREKIT_DENY=remote suppresses the remote section, offline still matches', () => {
  const { root, home } = seedProject();
  const res = runSearch(root, home, ['build', '--json'], { LOREKIT_DENY: 'remote' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.remote.available, false);
  assert.match(out.remote.reason, /deny constraint/);
  assert.equal(out.offline.total, 2);
});

// ── integration: a configured (mock) remote ───────────────────────────────────

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

test('search matches in a configured remote store too', async () => {
  const { root, home } = seedProject();
  const server = startMockRemote({
    global: [{ scope: 'global', key: 'remote-lesson', value: 'A remote sandbox tip.', updated_at: '2026-07-01T00:00:00Z' }],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await runSearchAsync(root, home, ['sandbox', '--json'], {
      LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      LOREKIT_TOKEN: 'lk_ro_test',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.remote.available, true);
    assert.equal(out.remote.total, 1);
    const keys = out.remote.groups.flatMap((g) => g.entries.map((e) => e.key));
    assert.ok(keys.includes('remote-lesson'));
    // Offline still matched independently.
    assert.equal(out.offline.total, 1);
  } finally {
    server.close();
  }
});
