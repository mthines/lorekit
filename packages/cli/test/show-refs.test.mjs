// `lorekit show <s1::k1> <s2::k2> ...` — the multi-ref form of `show` (R9, R16).
//
// Targets the LOCAL on-disk store via LOREKIT_HOME (+ a project `.lorekit/`
// tier for the two-tier precedence test) rather than a mock REST server — the
// mock-remote CLI tests are the ones that hit the pre-existing loopback-HTTP
// flakiness documented in CLAUDE.md; a purely offline read never touches the
// network at all, so it is unaffected. No LOREKIT_TOKEN / LOREKIT_MCP_URL is
// ever set here, matching `show.test.mjs`'s offline-only tests, so the Remote
// section always reports "unavailable" with zero network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

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

function writeEntry(baseDir, scopeDir, filename, opts) {
  const dir = path.join(baseDir, scopeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), entry(opts));
}

function runShow(root, home, extraArgs = [], extraEnv = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    LOREKIT_HOME: home,
    // Per CLAUDE.md's sandbox guidance: target the local on-disk store
    // directly rather than a mock REST server. Redundant with omitting
    // LOREKIT_TOKEN/LOREKIT_MCP_URL below (which is what actually keeps
    // `show` from attempting any network call), but stated explicitly so the
    // intent reads the same way in this file as it does in the project docs.
    LOREKIT_MODE: 'local',
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

// ── AC-9: three positionals that all parse as refs ────────────────────────────

test('AC-9: multi-ref show reports each of three positionals, in request order', () => {
  const root = tmp('lk-show-refs-proj-');
  const home = tmp('lk-show-refs-home-');
  const store = path.join(root, '.lorekit');
  writeEntry(store, 'global', 'a.md', { scope: 'global', key: 'lesson-one', value: 'value one', tags: ['t1'] });
  writeEntry(store, 'global', 'b.md', { scope: 'global', key: 'lesson-two', value: 'value two', tags: [] });
  writeEntry(store, path.join('project', 'demo'), 'c.md', { scope: 'project::demo', key: 'lesson-three', value: 'value three', tags: [] });

  const res = runShow(root, home, [
    'global::lesson-one',
    'global::lesson-two',
    'project::demo::lesson-three',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.results.length, 3);

  // Request order is preserved — not sorted, not grouped by store.
  assert.equal(out.results[0].scope, 'global');
  assert.equal(out.results[0].key, 'lesson-one');
  assert.equal(out.results[0].offline.record.value, 'value one');

  assert.equal(out.results[1].scope, 'global');
  assert.equal(out.results[1].key, 'lesson-two');
  assert.equal(out.results[1].offline.record.value, 'value two');

  assert.equal(out.results[2].scope, 'project::demo');
  assert.equal(out.results[2].key, 'lesson-three');
  assert.equal(out.results[2].offline.record.value, 'value three');

  for (const r of out.results) {
    assert.equal(r.offline.available, true);
    assert.equal(r.offline.found, true);
    assert.equal(r.remote.available, false);
    assert.equal(r.remote.found, false);
    assert.equal(r.diverged, false);
  }
});

test('AC-9: multi-ref show reports an unresolved ref alongside found ones (exit 1)', () => {
  const root = tmp('lk-show-refs-proj-');
  const home = tmp('lk-show-refs-home-');
  const store = path.join(root, '.lorekit');
  writeEntry(store, 'global', 'a.md', { scope: 'global', key: 'lesson-one', value: 'value one' });

  const res = runShow(root, home, ['global::lesson-one', 'global::does-not-exist', '--json']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].offline.found, true);
  assert.equal(out.results[1].offline.found, false);
  assert.equal(out.results[1].offline.available, true); // available, just not found
});

// ── AC-9 backward compatibility: existing single-ref forms are untouched ──────
//
// Fixture literals below mirror EXACTLY what `show`'s pre-existing single-ref
// path produces (the same `{ scope, key, offline, remote, diverged }` shape
// `show.test.mjs`'s own `--json` assertions pin) — the multi-ref branch is a
// new early return gated on `isMultiRefForm`, which is false for both of these
// invocations (a bare `<scope>` positional has no `::`, so `resolveScopeArg`
// reports a null key and the predicate never fires), so the single-ref code
// path below runs completely unmodified.

test('AC-9: the two-positional <scope> <key> form is unchanged', () => {
  const root = tmp('lk-show-refs-proj-');
  const home = tmp('lk-show-refs-home-');
  const store = path.join(root, '.lorekit');
  writeEntry(store, 'global', 'a.md', { scope: 'global', key: 'compat-key', value: 'compat value', tags: ['x'] });

  const res = runShow(root, home, ['global', 'compat-key', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, 'global');
  assert.equal(out.key, 'compat-key');
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.found, true);
  assert.equal(out.offline.record.value, 'compat value');
  assert.deepEqual(out.offline.record.tags, ['x']);
  assert.equal(out.remote.available, false);
  assert.equal(out.remote.found, false);
  assert.equal(out.diverged, false);
  // No `results` array leaks into the single-ref shape.
  assert.equal('results' in out, false);
});

test('AC-9: the --scope/--key flag form is unchanged', () => {
  const root = tmp('lk-show-refs-proj-');
  const home = tmp('lk-show-refs-home-');
  const store = path.join(root, '.lorekit');
  writeEntry(store, 'global', 'a.md', { scope: 'global', key: 'compat-key', value: 'compat value', tags: ['x'] });

  const res = runShow(root, home, ['--scope', 'global', '--key', 'compat-key', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, 'global');
  assert.equal(out.key, 'compat-key');
  assert.equal(out.offline.available, true);
  assert.equal(out.offline.found, true);
  assert.equal(out.offline.record.value, 'compat value');
  assert.equal(out.remote.available, false);
  assert.equal(out.diverged, false);
  assert.equal('results' in out, false);
});

// ── AC-10: offline resolution preserves project-over-home precedence ──────────

test('AC-10: multi-ref show resolves offline with project-over-home precedence', () => {
  const root = tmp('lk-show-refs-proj-');
  const home = tmp('lk-show-refs-home-');
  const store = path.join(root, '.lorekit');

  // The SAME scope::key seeded in both tiers with DIFFERENT values.
  writeEntry(store, 'global', 'shared.md', { scope: 'global', key: 'shared-key', value: 'project value' });
  writeEntry(home, 'global', 'shared.md', { scope: 'global', key: 'shared-key', value: 'home value' });
  // A second ref that exists ONLY in the home tier, to prove the home tier is
  // still consulted (project shadows on a collision, it doesn't exclude it).
  writeEntry(home, 'global', 'home-only.md', { scope: 'global', key: 'home-only', value: 'home-only value' });

  const res = runShow(root, home, ['global::shared-key', 'global::home-only', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);

  const shared = out.results.find((r) => r.key === 'shared-key');
  assert.equal(shared.offline.found, true);
  assert.equal(shared.offline.record.value, 'project value'); // project tier wins

  const homeOnly = out.results.find((r) => r.key === 'home-only');
  assert.equal(homeOnly.offline.found, true);
  assert.equal(homeOnly.offline.record.value, 'home-only value');

  // No network call was made — the Remote section reports unconfigured, not
  // an error, for every ref.
  for (const r of out.results) {
    assert.equal(r.remote.available, false);
    assert.match(r.remote.reason, /no endpoint configured|no token configured/);
  }
});
