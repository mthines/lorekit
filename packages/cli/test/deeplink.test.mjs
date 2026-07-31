// Coverage for the deep-link feature — the shared pure builder, the `link`
// command, and the `--link` flag on the read commands.
//
// Two layers:
//   • unit — the pure `deeplink-pure.mjs` builder: EXACT URL shape/encoding per
//     surface, default-omission, base override, and a round-trip that decodes
//     each param the way the web app's `useUrlState` does (JSON.parse) to prove
//     the JSON-encoding rule holds end to end;
//   • integration — the real binary spawned with an isolated HOME and telemetry
//     off, asserting stdout is the bare URL (pipeable) and `--json` is structured,
//     for `link` and for `--link` on show / search / list / tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_APP_BASE,
  resolveAppBase,
  encodeParam,
  buildLoreQuery,
  buildLoreUrl,
  loreScopeUrl,
  buildLessonUrl,
  parseOwnerArg,
  parseViewArg,
  parseRangeArg,
  mostSpecificScope,
  surfaceFor,
} from '../src/deeplink-pure.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: base resolution ─────────────────────────────────────────────────────

test('resolveAppBase: default, env, flag precedence, and trailing-slash strip', () => {
  assert.equal(resolveAppBase(), DEFAULT_APP_BASE);
  assert.equal(resolveAppBase({ env: {} }), 'https://lorekit.io');
  assert.equal(resolveAppBase({ env: { LOREKIT_APP_URL: 'https://lore.acme.dev' } }), 'https://lore.acme.dev');
  // --base wins over the env var; both get trailing slashes stripped.
  assert.equal(
    resolveAppBase({ base: 'https://flag.example/', env: { LOREKIT_APP_URL: 'https://env.example' } }),
    'https://flag.example',
  );
  // A blank flag falls through to the env var, then the default.
  assert.equal(resolveAppBase({ base: '   ', env: { LOREKIT_APP_URL: 'https://env.example' } }), 'https://env.example');
});

// ── unit: encoding + query assembly ───────────────────────────────────────────

test('encodeParam JSON-encodes then URL-encodes (the inverse of the app read)', () => {
  assert.equal(encodeParam('global'), '%22global%22');
  assert.equal(encodeParam('repo::owner/repo'), '%22repo%3A%3Aowner%2Frepo%22');
  assert.equal(encodeParam({ scope: 'global', key: 'k' }), '%7B%22scope%22%3A%22global%22%2C%22key%22%3A%22k%22%7D');
});

test('buildLoreQuery omits params equal to their default', () => {
  assert.equal(buildLoreQuery({}), '');
  assert.equal(buildLoreQuery({ scope: null, q: '', owner: 'all', view: 'scope', archived: false, range: null, lesson: null }), '');
  // undefined values are skipped too.
  assert.equal(buildLoreQuery({ scope: undefined }), '');
});

test('buildLoreQuery encodes each non-default param and honours PARAM_ORDER', () => {
  assert.equal(buildLoreQuery({ scope: 'global' }), 'scope=%22global%22');
  assert.equal(buildLoreQuery({ q: 'flaky test' }), 'q=%22flaky%20test%22');
  assert.equal(buildLoreQuery({ owner: 'personal' }), 'owner=%22personal%22');
  assert.equal(buildLoreQuery({ owner: { orgId: 'org_123' } }), 'owner=%7B%22orgId%22%3A%22org_123%22%7D');
  assert.equal(buildLoreQuery({ view: 'time' }), 'view=%22time%22');
  assert.equal(buildLoreQuery({ archived: true }), 'archived=true');
  assert.equal(
    buildLoreQuery({ range: { from: '2026-01-01', to: '2026-02-01' } }),
    'range=%7B%22from%22%3A%222026-01-01%22%2C%22to%22%3A%222026-02-01%22%7D',
  );
  // scope precedes q precedes lesson (stable, readable order).
  assert.equal(
    buildLoreQuery({ q: 'x', scope: 'global', lesson: { scope: 'global', key: 'k' } }),
    'scope=%22global%22&q=%22x%22&lesson=%7B%22scope%22%3A%22global%22%2C%22key%22%3A%22k%22%7D',
  );
});

// ── unit: surface builders ────────────────────────────────────────────────────

test('buildLoreUrl: bare /lore with no params, base override strips trailing slash', () => {
  assert.equal(buildLoreUrl({}), 'https://lorekit.io/lore');
  assert.equal(buildLoreUrl({ scope: 'global' }, { base: 'https://acme.dev/' }), 'https://acme.dev/lore?scope=%22global%22');
});

test('loreScopeUrl: null/empty → bare, a real scope (incl. global) → ?scope=...', () => {
  assert.equal(loreScopeUrl(null), 'https://lorekit.io/lore');
  assert.equal(loreScopeUrl(''), 'https://lorekit.io/lore');
  assert.equal(loreScopeUrl('global'), 'https://lorekit.io/lore?scope=%22global%22');
  assert.equal(loreScopeUrl('repo::owner/repo'), 'https://lorekit.io/lore?scope=%22repo%3A%3Aowner%2Frepo%22');
});

test('buildLessonUrl sets BOTH scope and lesson so the sheet is not blank', () => {
  assert.equal(
    buildLessonUrl('repo::owner/repo', 'my-key'),
    'https://lorekit.io/lore?scope=%22repo%3A%3Aowner%2Frepo%22&lesson=%7B%22scope%22%3A%22repo%3A%3Aowner%2Frepo%22%2C%22key%22%3A%22my-key%22%7D',
  );
});

// ── unit: flag coercion ───────────────────────────────────────────────────────

test('parseOwnerArg maps to the OwnerFilter shape', () => {
  assert.equal(parseOwnerArg(undefined), 'all');
  assert.equal(parseOwnerArg('all'), 'all');
  assert.equal(parseOwnerArg('personal'), 'personal');
  assert.deepEqual(parseOwnerArg('org_abc'), { orgId: 'org_abc' });
});

test('parseViewArg only accepts time; anything else is the scope default', () => {
  assert.equal(parseViewArg('time'), 'time');
  assert.equal(parseViewArg('scope'), 'scope');
  assert.equal(parseViewArg(undefined), 'scope');
  assert.equal(parseViewArg('bogus'), 'scope');
});

test('parseRangeArg: JSON --range wins, else --from/--to shorthand, else null', () => {
  assert.equal(parseRangeArg({}), null);
  assert.deepEqual(parseRangeArg({ range: '{"from":"2026-01-01","to":"2026-02-01"}' }), { from: '2026-01-01', to: '2026-02-01' });
  assert.equal(parseRangeArg({ range: 'not json' }), null); // malformed → null, never throws
  assert.deepEqual(parseRangeArg({ from: '2026-01-01', to: '2026-02-01' }), { from: '2026-01-01', to: '2026-02-01' });
  assert.deepEqual(parseRangeArg({ from: '2026-01-01' }), { from: '2026-01-01', to: '' });
});

test('mostSpecificScope picks the first non-global scope, else null', () => {
  assert.equal(
    mostSpecificScope({ readOrder: ['project::x', 'branch::a/b::main', 'repo::a/b', 'global'] }),
    'project::x',
  );
  assert.equal(mostSpecificScope({ readOrder: ['repo::a/b', 'global'] }), 'repo::a/b');
  assert.equal(mostSpecificScope({ readOrder: ['global'] }), null);
  assert.equal(mostSpecificScope({}), null);
});

test('surfaceFor classifies a params object', () => {
  assert.equal(surfaceFor({}), 'explorer');
  assert.equal(surfaceFor({ scope: 'global' }), 'scope');
  assert.equal(surfaceFor({ q: 'x' }), 'search');
  assert.equal(surfaceFor({ scope: 'global', lesson: { scope: 'global', key: 'k' } }), 'lesson');
});

// ── unit: round-trip against the app's read (JSON.parse) ──────────────────────

// Decode a built URL the way the web app's `useUrlState.deserialise` does:
// JSON.parse(searchParams.get(key)), so a round-trip proves the encoding the
// builder emits is exactly what the app reads back.
function decodeParams(url) {
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const out = {};
  for (const pair of qs ? qs.split('&') : []) {
    const idx = pair.indexOf('=');
    const key = pair.slice(0, idx);
    out[key] = JSON.parse(decodeURIComponent(pair.slice(idx + 1)));
  }
  return out;
}

test('round-trip: every surface decodes back to the exact input values', () => {
  assert.deepEqual(decodeParams(loreScopeUrl('global')), { scope: 'global' });
  assert.deepEqual(decodeParams(loreScopeUrl('repo::owner/repo')), { scope: 'repo::owner/repo' });
  assert.deepEqual(decodeParams(buildLessonUrl('branch::owner/repo::feat/x', 'k1')), {
    scope: 'branch::owner/repo::feat/x',
    lesson: { scope: 'branch::owner/repo::feat/x', key: 'k1' },
  });
  assert.deepEqual(
    decodeParams(buildLoreUrl({ q: 'flaky', owner: { orgId: 'o1' }, view: 'time', archived: true })),
    { q: 'flaky', owner: { orgId: 'o1' }, view: 'time', archived: true },
  );
});

// ── integration: the real `link` binary ───────────────────────────────────────

function run(args, { dir, extraEnv = {} } = {}) {
  const home = tmp('lk-link-home-');
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
  delete env.LOREKIT_APP_URL;
  // extraEnv is applied LAST so a test can set (or restore) any of the above.
  Object.assign(env, extraEnv);
  const dirArgs = dir ? ['--dir', dir] : [];
  return spawnSync(process.execPath, [BIN, ...args, ...dirArgs], { encoding: 'utf8', env });
}

test('link <scope> prints exactly the JSON-encoded scope URL on stdout', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'https://lorekit.io/lore?scope=%22global%22');
});

test('link <scope> <key> deep-links to the lesson (both scope and lesson params)', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'repo::acme/widget', 'prefer-guards'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const url = res.stdout.trim();
  assert.match(url, /scope=%22repo%3A%3Aacme%2Fwidget%22/);
  assert.match(url, /lesson=/);
  assert.deepEqual(decodeParams(url), {
    scope: 'repo::acme/widget',
    lesson: { scope: 'repo::acme/widget', key: 'prefer-guards' },
  });
});

test('link <scope::key> shorthand equals the two-positional form', () => {
  const root = tmp('lk-link-proj-');
  const a = run(['link', 'global::my-key'], { dir: root });
  const b = run(['link', 'global', 'my-key'], { dir: root });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout.trim(), b.stdout.trim());
});

test('link --json emits { url, surface, base, params }', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global::my-key', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.surface, 'lesson');
  assert.equal(out.base, 'https://lorekit.io');
  assert.deepEqual(out.params, { scope: 'global', lesson: { scope: 'global', key: 'my-key' } });
  assert.match(out.url, /^https:\/\/lorekit\.io\/lore\?/);
});

test('link --base and LOREKIT_APP_URL override the dashboard host', () => {
  const root = tmp('lk-link-proj-');
  const flag = run(['link', 'global', '--base', 'https://lore.acme.dev'], { dir: root });
  assert.equal(flag.stdout.trim(), 'https://lore.acme.dev/lore?scope=%22global%22');
  const env = run(['link', 'global'], { dir: root, extraEnv: { LOREKIT_APP_URL: 'https://env.acme.dev' } });
  assert.equal(env.stdout.trim(), 'https://env.acme.dev/lore?scope=%22global%22');
});

test('link with filter flags composes q + owner + archived', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global', '--q', 'flaky', '--owner', 'personal', '--archived', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // A query present makes the salient surface 'search' even alongside a scope.
  assert.equal(out.surface, 'search');
  assert.deepEqual(out.params, { scope: 'global', q: 'flaky', owner: 'personal', archived: true });
});

test('bare link (no args) links to the cwd project scope', () => {
  // A plain temp dir has no git remote, so deriveScope yields project + global;
  // the most-specific is the project scope.
  const root = tmp('lk-link-proj-');
  const res = run(['link'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /^https:\/\/lorekit\.io\/lore\?scope=%22project%3A%3A/);
});

test('url alias resolves to link', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['url', 'global'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'https://lorekit.io/lore?scope=%22global%22');
});

// ── integration: the --link flag on the read commands ─────────────────────────

test('show --link prints the lesson deep link without reading a store', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['show', 'global::my-key', '--link'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(decodeParams(res.stdout.trim()), {
    scope: 'global',
    lesson: { scope: 'global', key: 'my-key' },
  });
});

test('search <query> --link prints the search deep link (q + scope)', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['search', 'flaky', '--link', '--scope', 'global'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(decodeParams(res.stdout.trim()), { scope: 'global', q: 'flaky' });
});

test('list --link and tree --link print the scope-filtered Explorer link', () => {
  const root = tmp('lk-link-proj-');
  const listRes = run(['list', '--link', '--scope', 'global'], { dir: root });
  assert.equal(listRes.status, 0, listRes.stderr);
  assert.equal(listRes.stdout.trim(), 'https://lorekit.io/lore?scope=%22global%22');
  const treeRes = run(['tree', '--link', '--scope', 'global'], { dir: root });
  assert.equal(treeRes.status, 0, treeRes.stderr);
  assert.equal(treeRes.stdout.trim(), 'https://lorekit.io/lore?scope=%22global%22');
});

test('--link honours --json and --base on a read command', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['list', '--link', '--scope', 'global', '--base', 'https://acme.dev', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.base, 'https://acme.dev');
  assert.equal(out.surface, 'scope');
  assert.equal(out.url, 'https://acme.dev/lore?scope=%22global%22');
});
