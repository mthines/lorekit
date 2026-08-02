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
  LORE_PARAM_DEFAULTS,
  resolveAppBase,
  encodeParam,
  buildLoreQuery,
  buildLoreUrl,
  loreScopeUrl,
  buildLessonUrl,
  parseOwnerArg,
  parseViewArg,
  parseRangeArg,
  parseTagsArg,
  resolveScopeArg,
  mostSpecificScope,
  surfaceFor,
} from '../src/deeplink-pure.mjs';
import { scopeIssue } from '../src/lessons-view.mjs';

// The real validity predicate the `link` command injects.
const isScope = (s) => scopeIssue(s) === null;

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

test('resolveScopeArg: a valid scope (incl. `::` scopes) is a scope filter, never a bogus lesson', () => {
  // The blocking regression: every non-global scope contains `::`, and a naive
  // first-`::` split turned it into scope="repo" + a bogus key.
  assert.deepEqual(resolveScopeArg('global', isScope), { scope: 'global', key: null });
  assert.deepEqual(resolveScopeArg('repo::owner/repo', isScope), { scope: 'repo::owner/repo', key: null });
  assert.deepEqual(resolveScopeArg('project::widget', isScope), { scope: 'project::widget', key: null });
  assert.deepEqual(resolveScopeArg('branch::owner/repo::feat/x', isScope), {
    scope: 'branch::owner/repo::feat/x',
    key: null,
  });
});

test('resolveScopeArg: `<scope>::<key>` shorthand splits at the LAST `::`, keeping multi-segment scopes intact', () => {
  assert.deepEqual(resolveScopeArg('global::my-key', isScope), { scope: 'global', key: 'my-key' });
  assert.deepEqual(resolveScopeArg('repo::owner/repo::my-key', isScope), {
    scope: 'repo::owner/repo',
    key: 'my-key',
  });
  assert.deepEqual(resolveScopeArg('branch::owner/repo::feat/x::my-key', isScope), {
    scope: 'branch::owner/repo::feat/x',
    key: 'my-key',
  });
});

test('resolveScopeArg: an unresolvable/malformed arg becomes the scope, never a fabricated key', () => {
  assert.deepEqual(resolveScopeArg('repo::owneronly', isScope), { scope: 'repo::owneronly', key: null });
  assert.deepEqual(resolveScopeArg('', isScope), { scope: null, key: null });
  assert.deepEqual(resolveScopeArg('   ', isScope), { scope: null, key: null });
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

test('link <repo::owner/name> (single positional) is a scope filter, NOT a bogus lesson', () => {
  // Regression guard for the blocking review finding.
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'repo::acme/widget'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(decodeParams(res.stdout.trim()), { scope: 'repo::acme/widget' });
  assert.doesNotMatch(res.stdout, /lesson=/);
});

test('link <repo::owner/name::key> shorthand deep-links the lesson under the full repo scope', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'repo::acme/widget::prefer-guards', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.surface, 'lesson');
  assert.deepEqual(out.params, {
    scope: 'repo::acme/widget',
    lesson: { scope: 'repo::acme/widget', key: 'prefer-guards' },
  });
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

test('link --range JSON flows through the command into the range param', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global', '--range', '{"from":"2026-01-01","to":"2026-02-01"}', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.params, { scope: 'global', range: { from: '2026-01-01', to: '2026-02-01' } });
  assert.deepEqual(decodeParams(out.url), { scope: 'global', range: { from: '2026-01-01', to: '2026-02-01' } });
});

test('link --from/--to shorthand flows through the command into the range param', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global', '--from', '2026-01-01', '--to', '2026-02-01', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.params.range, { from: '2026-01-01', to: '2026-02-01' });
});

test('link --view time flows through the command into the view param', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global', '--view', 'time', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.params, { scope: 'global', view: 'time' });
  assert.deepEqual(decodeParams(out.url), { scope: 'global', view: 'time' });
});

test('link --owner <orgId> flows through the command as the { orgId } object form', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global', '--owner', 'org_abc', '--json'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.params.owner, { orgId: 'org_abc' });
  assert.deepEqual(decodeParams(out.url).owner, { orgId: 'org_abc' });
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

// ── unit: the `tags` label filter ─────────────────────────────────────────────

test('parseTagsArg: comma form, JSON-array form, normalization, and empties', () => {
  // Comma-separated is trimmed, de-duplicated, order-preserving.
  assert.deepEqual(parseTagsArg('perf, ci, perf, '), ['perf', 'ci']);
  // A JSON array string is accepted and normalized the same way.
  assert.deepEqual(parseTagsArg('["perf"," ci ","perf"]'), ['perf', 'ci']);
  // An already-array input is normalized too (drops non-strings/empties).
  assert.deepEqual(parseTagsArg(['a', '', 'a', 2, 'b']), ['a', 'b']);
  // A malformed JSON array falls back to comma-splitting rather than throwing.
  assert.deepEqual(parseTagsArg('[perf'), ['[perf']);
  // Absent / blank → [] (the default, so it is omitted from the URL).
  assert.deepEqual(parseTagsArg(undefined), []);
  assert.deepEqual(parseTagsArg('   '), []);
});

test('buildLoreUrl encodes tags as a JSON array and omits the empty default', () => {
  assert.equal(
    buildLoreUrl({ scope: 'global', tags: ['perf', 'ci'] }),
    'https://lorekit.io/lore?scope=%22global%22&tags=%5B%22perf%22%2C%22ci%22%5D',
  );
  // An empty tags array equals the default → omitted, same as no tags at all.
  assert.equal(buildLoreUrl({ scope: 'global', tags: [] }), 'https://lorekit.io/lore?scope=%22global%22');
  // Round-trip: the app reads it back via JSON.parse.
  const url = new URL(buildLoreUrl({ tags: ['perf', 'ci'] }));
  assert.deepEqual(JSON.parse(url.searchParams.get('tags')), ['perf', 'ci']);
});

test('link --tags prints the label-filtered Explorer link', () => {
  const root = tmp('lk-link-proj-');
  const res = run(['link', 'global', '--tags', 'perf,ci'], { dir: root });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    res.stdout.trim(),
    'https://lorekit.io/lore?scope=%22global%22&tags=%5B%22perf%22%2C%22ci%22%5D',
  );
});

// ── web ↔ CLI drift guard ─────────────────────────────────────────────────────
// `LORE_PARAM_DEFAULTS` mirrors the /lore Explorer's `useUrlState` params
// (packages/web). This reads the ACTUAL param set from the web source — it never
// hardcodes it — so a new Explorer filter (or a changed default) fails HERE
// instead of silently producing a link the dashboard ignores. This is the guard
// that would have caught the missing `tags` param.

const WEB_SOURCES = [
  '../../web/src/components/lore/LoreExplorer.tsx',
  '../../web/src/components/providers/MemorySidebarProvider.tsx',
].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));

const WEB_SOURCES_PRESENT = WEB_SOURCES.every((p) => fs.existsSync(p));

// Extract every URL-backed param from `use[Debounced]UrlState<…>('key', <default>, …)`
// calls into a Map of key → raw default token (as written in source).
function extractUrlStateParams(src) {
  const re = /use(?:Debounced)?UrlState<[^>]*>\(\s*'([^']+)'\s*,\s*([^,)]+?)\s*[,)]/g;
  const found = new Map();
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!found.has(m[1])) found.set(m[1], m[2].trim());
  }
  return found;
}

// Parse a simple literal default token to a value. `NO_TAGS` is the web
// module-scoped `[]` alias. Complex tokens report `ok: false` so the value check
// is skipped for them (the key-set check still covers presence).
function parseDefaultToken(tok) {
  if (tok === 'null') return { ok: true, value: null };
  if (tok === 'true') return { ok: true, value: true };
  if (tok === 'false') return { ok: true, value: false };
  if (tok === 'NO_TAGS') return { ok: true, value: [] };
  const str = /^'([^']*)'$/.exec(tok) || /^"([^"]*)"$/.exec(tok);
  if (str) return { ok: true, value: str[1] };
  return { ok: false };
}

function readWebParams() {
  const params = new Map();
  for (const p of WEB_SOURCES) {
    for (const [k, v] of extractUrlStateParams(fs.readFileSync(p, 'utf8'))) {
      if (!params.has(k)) params.set(k, v);
    }
  }
  return params;
}

test(
  'web ↔ CLI: LORE_PARAM_DEFAULTS covers exactly the Explorer useUrlState params',
  { skip: WEB_SOURCES_PRESENT ? false : 'packages/web sources not present in this checkout' },
  () => {
    const webKeys = [...readWebParams().keys()].sort();
    const cliKeys = Object.keys(LORE_PARAM_DEFAULTS).sort();
    assert.deepEqual(
      webKeys,
      cliKeys,
      `deeplink-pure.mjs LORE_PARAM_DEFAULTS must match the /lore Explorer useUrlState params.\n` +
        `  web: ${webKeys.join(', ')}\n  cli: ${cliKeys.join(', ')}`,
    );
  },
);

test(
  'web ↔ CLI: scalar param defaults agree with the Explorer',
  { skip: WEB_SOURCES_PRESENT ? false : 'packages/web sources not present in this checkout' },
  () => {
    for (const [key, token] of readWebParams()) {
      const parsed = parseDefaultToken(token);
      if (!parsed.ok) continue; // complex default — presence is covered by the key test
      assert.equal(
        JSON.stringify(parsed.value),
        JSON.stringify(LORE_PARAM_DEFAULTS[key]),
        `default for '${key}' drifted: web ${JSON.stringify(parsed.value)} vs cli ${JSON.stringify(LORE_PARAM_DEFAULTS[key])}`,
      );
    }
  },
);

// ── docs accuracy ─────────────────────────────────────────────────────────────
// The example URLs printed in the deep-links docs page must be byte-for-byte
// reproducible by the builder, so the docs can never drift from the encoding.

const DOCS_PAGE = fileURLToPath(new URL('../../web/src/content/docs/deep-links.mdx', import.meta.url));
const DOCS_PAGE_PRESENT = fs.existsSync(DOCS_PAGE);

test(
  'docs: every example URL in deep-links.mdx is reproducible by the builder',
  { skip: DOCS_PAGE_PRESENT ? false : 'deep-links.mdx not present in this checkout' },
  () => {
    const page = fs.readFileSync(DOCS_PAGE, 'utf8');
    const expected = [
      loreScopeUrl('global'),
      loreScopeUrl('repo::acme/widget'),
      buildLessonUrl('global', 'prefer-guard-clauses'),
      buildLoreUrl({ q: 'flaky test', owner: 'personal' }),
      buildLoreUrl({ scope: 'global', tags: ['perf', 'ci'] }),
      buildLoreUrl({ scope: 'global', view: 'time', archived: true }),
      buildLoreUrl({ scope: 'global' }, { base: 'https://lore.acme.dev' }),
    ];
    for (const url of expected) {
      assert.ok(page.includes(url), `deep-links.mdx is missing (or misencodes) the documented URL: ${url}`);
    }
  },
);
