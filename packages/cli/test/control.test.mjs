// Control-model resolver tests: mode selection, precedence, and deny-wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveControl, normalizeMode, loadControl, resolveDenies,
  normalizeSessionStartMode, DEFAULT_SESSION_START_MAX_CHARS,
  MIN_SESSION_START_MAX_CHARS, MAX_SESSION_START_MAX_CHARS,
  HOOK_INSTRUCTION_EVENTS,
} from '../src/control.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-ctl-'));
}

const USABLE = { usable: true, endpoint: 'https://ref.supabase.co/functions/v1/mcp', token: 'lk_rw_x' };
const NO_CONN = { usable: false, endpoint: null, token: null };

test('hooks.instructions resolves every lifecycle event, UserPromptSubmit included', () => {
  // The resolver used to iterate a private three-event literal, so a
  // `UserPromptSubmit` instruction was accepted in config and silently dropped.
  assert.deepEqual(HOOK_INSTRUCTION_EVENTS, [
    'SessionStart', 'UserPromptSubmit', 'PostToolUseFailure', 'Stop',
  ]);
  const r = resolveControl({
    connection: NO_CONN,
    repoConfig: {
      'hooks.instructions': {
        SessionStart: 'a',
        UserPromptSubmit: 'b',
        PostToolUseFailure: 'c',
        Stop: 'd',
      },
    },
  });
  assert.deepEqual(Object.keys(r.hooksInstructions), HOOK_INSTRUCTION_EVENTS);
  assert.equal(r.hooksInstructions.UserPromptSubmit, 'b');
});

test('normalizeMode accepts friendly spellings incl. persistent-memory backends', () => {
  assert.equal(normalizeMode('REMOTE'), 'remote');
  assert.equal(normalizeMode('lorekit'), 'remote');
  assert.equal(normalizeMode('markdown'), 'local');
  assert.equal(normalizeMode('disabled'), 'off');
  assert.equal(normalizeMode('nonsense'), null);
});

test('default is remote when a usable connection exists (backward compatible)', () => {
  const r = resolveControl({ connection: USABLE });
  assert.equal(r.mode, 'remote');
  assert.match(r.decidedBy, /default \(remote connection/);
  assert.equal(r.storeTarget, USABLE.endpoint);
});

test('default is remote when nothing is configured (nudges fire, reads silent until usable)', () => {
  // Preserves pre-control behaviour: the mode is remote even before a
  // connection exists, so the backend-agnostic nudges keep firing; reads are
  // silent because the remote store is unusable. `off` is explicit-only.
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.mode, 'remote');
  assert.match(r.decidedBy, /not yet configured/);
  assert.equal(r.storeTarget, null);
});

test('off mode: explicit env disables even with a usable connection', () => {
  const r = resolveControl({ env: { LOREKIT_MODE: 'off' }, connection: USABLE });
  assert.equal(r.mode, 'off');
  assert.match(r.decidedBy, /env LOREKIT_MODE/);
});

test('precedence: env beats user, user beats repo', () => {
  const repoLocalUserRemote = resolveControl({
    userConfig: { mode: 'remote' },
    repoConfig: { mode: 'local' },
    connection: USABLE,
  });
  assert.equal(repoLocalUserRemote.mode, 'remote'); // user preference wins over repo default
  assert.match(repoLocalUserRemote.decidedBy, /user config/);

  const envWins = resolveControl({
    env: { LOREKIT_MODE: 'local' },
    userConfig: { mode: 'remote' },
    connection: USABLE,
    root: '/proj',
  });
  assert.equal(envWins.mode, 'local'); // env beats user
});

test('WORKED CASE — never-remote user in a remote-default repo resolves local, NOT remote', () => {
  const r = resolveControl({
    userConfig: { mode: 'local', deny: ['remote'] }, // privacy: never remote, prefer local
    repoConfig: { mode: 'remote' }, // repo defaults remote
    connection: USABLE,
    root: '/proj',
    home: '/home/.lorekit',
  });
  assert.equal(r.mode, 'local');
  assert.notEqual(r.mode, 'remote');
  assert.ok(r.denies.some((d) => d.mode === 'remote'));
  assert.deepEqual(r.storeTarget, { home: '/home/.lorekit', project: '/proj/.lorekit' });
});

test('WORKED CASE — never-remote user with no positive selection falls to off (never remote)', () => {
  const r = resolveControl({
    userConfig: { deny: ['remote'] }, // only a deny, no mode
    repoConfig: { mode: 'remote' }, // repo only offers remote
    connection: USABLE,
  });
  assert.equal(r.mode, 'off'); // capped down from the denied remote selections
  assert.notEqual(r.mode, 'remote');
  assert.match(r.decidedBy, /after deny: remote/);
});

test('WORKED CASE — never-local CI: repo denies local, so an env local select is capped', () => {
  const r = resolveControl({
    env: { LOREKIT_MODE: 'local' }, // CI job tries local
    repoConfig: { deny: ['local'] }, // repo/CI policy: no .lore in the tree
    connection: USABLE,
  });
  assert.notEqual(r.mode, 'local');
  assert.equal(r.mode, 'remote'); // falls through to the usable remote connection
  assert.ok(r.denies.some((d) => d.mode === 'local'));
  assert.match(r.decidedBy, /after deny: local/);
});

test('WORKED CASE — locked-down CI denying both modes resolves off', () => {
  // Deny both local and remote → only the terminal `off` fallback remains.
  const r = resolveControl({
    env: { LOREKIT_MODE: 'local', LOREKIT_DENY: 'local,remote' },
    connection: NO_CONN,
  });
  assert.equal(r.mode, 'off');
  assert.notEqual(r.mode, 'local');
  assert.match(r.decidedBy, /after deny/);
});

test('deny-wins: a repo cannot lift a user deny (union only accumulates)', () => {
  const r = resolveControl({
    userConfig: { deny: ['remote'] },
    repoConfig: { mode: 'remote' }, // repo tries to force remote — must fail
    userConfigMode: undefined,
    connection: USABLE,
  });
  assert.notEqual(r.mode, 'remote');
  assert.ok(r.denies.some((d) => d.mode === 'remote' && /user config/.test(d.source)));
});

test('user-vs-repo selection conflict within allowed: repo default used when user is silent', () => {
  const r = resolveControl({ repoConfig: { mode: 'local' }, connection: USABLE, root: '/p' });
  assert.equal(r.mode, 'local');
  assert.match(r.decidedBy, /repo/);
});

test('local storeTarget is two-tier: home from LOREKIT_HOME, project defaults to <root>/.lorekit', () => {
  const r = resolveControl({ env: { LOREKIT_MODE: 'local', LOREKIT_HOME: '/h/.lorekit' }, root: '/p' });
  assert.deepEqual(r.storeTarget, { home: '/h/.lorekit', project: '/p/.lorekit' });
});

test('LOREKIT_STORE / config store dir override the default .lorekit project path', () => {
  const abs = resolveControl({
    env: { LOREKIT_MODE: 'local', LOREKIT_HOME: '/h', LOREKIT_STORE: '/abs/lore' },
    root: '/p',
  });
  assert.deepEqual(abs.storeTarget, { home: '/h', project: '/abs/lore' });
  const rel = resolveControl({
    env: { LOREKIT_MODE: 'local', LOREKIT_HOME: '/h', LOREKIT_STORE: 'mem' },
    root: '/p',
  });
  assert.deepEqual(rel.storeTarget, { home: '/h', project: '/p/mem' });
});

test('user config is read from $LOREKIT_HOME/config.json (the ~/.lorekit move)', () => {
  const home = tmpDir();
  const root = tmpDir();
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ mode: 'local', deny: ['remote'] }),
  );
  const r = loadControl(root, { env: { LOREKIT_HOME: home } });
  assert.equal(r.mode, 'local');
  assert.ok(r.denies.some((d) => d.mode === 'remote' && /\.lorekit\/config\.json/.test(d.source)));
  assert.deepEqual(r.storeTarget, { home, project: path.join(root, '.lorekit') });
});

// ── resolveDenies — the shared deny-wins seam for the read commands ───────────

test('resolveDenies returns null on both sides when no deny is active', () => {
  const home = tmpDir();
  const root = tmpDir();
  const { localDenied, remoteDenied } = resolveDenies(root, { env: { LOREKIT_HOME: home } });
  assert.equal(localDenied, null);
  assert.equal(remoteDenied, null);
});

test('resolveDenies surfaces the matched deny object (mode + source) per side', () => {
  const home = tmpDir();
  const root = tmpDir();
  const env = { LOREKIT_HOME: home, LOREKIT_DENY: 'remote' };
  const { localDenied, remoteDenied } = resolveDenies(root, { env });
  assert.equal(localDenied, null);
  assert.equal(remoteDenied.mode, 'remote');
  assert.match(remoteDenied.source, /LOREKIT_DENY/);
});

test('resolveDenies reports both when both modes are denied (union, deny-wins)', () => {
  const home = tmpDir();
  const root = tmpDir();
  const env = { LOREKIT_HOME: home, LOREKIT_DENY: 'local,remote' };
  const { localDenied, remoteDenied } = resolveDenies(root, { env });
  assert.equal(localDenied.mode, 'local');
  assert.equal(remoteDenied.mode, 'remote');
});

test('resolveDenies reads a deny from the user config file, not just env', () => {
  const home = tmpDir();
  const root = tmpDir();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ deny: ['local'] }));
  const { localDenied, remoteDenied } = resolveDenies(root, { env: { LOREKIT_HOME: home } });
  assert.equal(localDenied.mode, 'local');
  assert.match(localDenied.source, /config\.json/);
  assert.equal(remoteDenied, null);
});

// ── New config properties ─────────────────────────────────────────────────────

test('tags.default: both config layers merged, user supplements repo', () => {
  const r = resolveControl({
    repoConfig: { 'tags.default': ['team', 'project::lorekit'] },
    userConfig: { 'tags.default': ['personal'] },
    connection: NO_CONN,
  });
  assert.deepEqual(r.tagsDefault, ['team', 'project::lorekit', 'personal']);
});

test('tags.default: empty when neither layer sets it', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.deepEqual(r.tagsDefault, []);
});

test('tags.default: comma-string form accepted', () => {
  const r = resolveControl({
    repoConfig: { 'tags.default': 'team,loop::aw-lessons' },
    connection: NO_CONN,
  });
  assert.deepEqual(r.tagsDefault, ['team', 'loop::aw-lessons']);
});

test('scope.defaults: map set from repoConfig', () => {
  const r = resolveControl({
    repoConfig: {
      'scope.defaults': {
        'repo::owner/name': { tags: ['team'] },
        'branch::owner/name::': { tags: ['ephemeral'] },
      },
    },
    connection: NO_CONN,
  });
  assert.ok(r.scopeDefaults);
  assert.deepEqual(r.scopeDefaults['repo::owner/name'], { tags: ['team'] });
});

test('scope.defaults: null when not set', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.scopeDefaults, null);
});

test('hooks.disabled: union of both layers, event suppressed', () => {
  const r = resolveControl({
    repoConfig: { 'hooks.disabled': ['Stop'] },
    userConfig: { 'hooks.disabled': ['PostToolUseFailure'] },
    connection: NO_CONN,
  });
  assert.ok(r.hooksDisabled.has('Stop'));
  assert.ok(r.hooksDisabled.has('PostToolUseFailure'));
  assert.ok(!r.hooksDisabled.has('SessionStart'));
});

test('hooks.disabled: empty set when not configured', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.hooksDisabled.size, 0);
});

test('hooks.adapter: repo wins over user', () => {
  const r = resolveControl({
    repoConfig: { 'hooks.adapter': 'cursor' },
    userConfig: { 'hooks.adapter': 'codex' },
    connection: NO_CONN,
  });
  assert.equal(r.hooksAdapter, 'cursor');
});

test('hooks.adapter: user fallback when repo is not set', () => {
  const r = resolveControl({
    userConfig: { 'hooks.adapter': 'codex' },
    connection: NO_CONN,
  });
  assert.equal(r.hooksAdapter, 'codex');
});

test('hooks.adapter: null when neither layer sets it', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.hooksAdapter, null);
});

// ── ttl.default ───────────────────────────────────────────────────────────────

test('ttl.default: repo layer wins over user (scalar policy, not a merge)', () => {
  const r = resolveControl({
    repoConfig: { 'ttl.default': 90 },
    userConfig: { 'ttl.default': 7 },
    connection: NO_CONN,
  });
  assert.equal(r.ttlDefault, 90);
});

test('ttl.default: user layer applies when the repo sets none', () => {
  const r = resolveControl({ userConfig: { 'ttl.default': 7 }, connection: NO_CONN });
  assert.equal(r.ttlDefault, 7);
});

test('ttl.default: null when neither layer sets it', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.ttlDefault, null);
});

test('ttl.default: numeric string form accepted (hand-edited JSON)', () => {
  const r = resolveControl({ repoConfig: { 'ttl.default': '30' }, connection: NO_CONN });
  assert.equal(r.ttlDefault, 30);
});

test('ttl.default: a non-numeric value resolves to null instead of throwing', () => {
  // resolveControl is on the path of every command, including read-only ones —
  // a typo in a config file must never break `lorekit list`. Range checking
  // happens later, at the point of use.
  for (const bad of ['soon', true, {}, [], null]) {
    const r = resolveControl({ repoConfig: { 'ttl.default': bad }, connection: NO_CONN });
    assert.equal(r.ttlDefault, null, `ttl.default=${JSON.stringify(bad)}`);
  }
});

test('ttl.default: an unusable repo value does NOT promote the user layer', () => {
  // The repo declared a policy and got it wrong. "Repo wins" has to hold for the
  // wrong value too, or a typo in a committed .lorekit.json silently hands the
  // project's retention policy to whatever each developer has in ~/.lorekit —
  // and `lorekit write` would print "(from config)" for a number the repo never
  // asked for. The bad value degrades to "no default", as documented.
  const r = resolveControl({
    repoConfig: { 'ttl.default': '90 days' },
    userConfig: { 'ttl.default': 7 },
    connection: NO_CONN,
  });
  assert.equal(r.ttlDefault, null);
});

test('ttl.default: layer selection matches hooks.adapter on the same input', () => {
  // Both keys are scalar policies that cannot merge, so a garbage repo value
  // must beat the user layer in both — the comment in control.mjs cites
  // hooks.adapter as the precedent, and this pins the two together.
  const r = resolveControl({
    repoConfig: { 'ttl.default': '90 days', 'hooks.adapter': 'bogus' },
    userConfig: { 'ttl.default': 7, 'hooks.adapter': 'cursor' },
    connection: NO_CONN,
  });
  assert.equal(r.hooksAdapter, 'bogus');
  assert.equal(r.ttlDefault, null);
});

test('ttl.default: an explicit repo null still falls through to the user layer', () => {
  // `null` is "I did not set one", not a declaration — unlike scope.defaults,
  // where an explicit `ttl_days: null` is the spelling of "permanent".
  for (const absent of [null, undefined, true, {}, []]) {
    const r = resolveControl({
      repoConfig: { 'ttl.default': absent },
      userConfig: { 'ttl.default': 7 },
      connection: NO_CONN,
    });
    assert.equal(r.ttlDefault, 7, `ttl.default=${JSON.stringify(absent)}`);
  }
});

test('ttl.default: out-of-range values survive resolveControl untouched', () => {
  // Bounds are NOT this function's job; resolveDefaultTtlDays drops them.
  const r = resolveControl({ repoConfig: { 'ttl.default': 900 }, connection: NO_CONN });
  assert.equal(r.ttlDefault, 900);
});

test('scope.defaults: ttl_days rides alongside tags on the same entry', () => {
  const r = resolveControl({
    repoConfig: { 'scope.defaults': { 'branch::': { tags: ['ephemeral'], ttl_days: 14 } } },
    connection: NO_CONN,
  });
  assert.deepEqual(r.scopeDefaults['branch::'], { tags: ['ephemeral'], ttl_days: 14 });
});

test('hooks.stop: defaults to friction when unset', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.hooksStop, 'friction');
});

test('hooks.stop: repo wins over user, friendly spellings normalized', () => {
  const r = resolveControl({
    repoConfig: { 'hooks.stop': 'always' },
    userConfig: { 'hooks.stop': 'off' },
    connection: NO_CONN,
  });
  assert.equal(r.hooksStop, 'always');
});

test('hooks.stop: user fallback when repo is unset; invalid falls through to default', () => {
  assert.equal(
    resolveControl({ userConfig: { 'hooks.stop': 'never' }, connection: NO_CONN }).hooksStop,
    'off',
  );
  assert.equal(
    resolveControl({ repoConfig: { 'hooks.stop': 'nonsense' }, connection: NO_CONN }).hooksStop,
    'friction',
  );
});

// ── hooks.sessionStart — the shape and the budget of the injected block ───────

test('control hooks.sessionStart: defaults to hybrid at the default budget', () => {
  const r = resolveControl({ connection: NO_CONN });
  assert.equal(r.hooksSessionStart, 'hybrid');
  assert.equal(r.hooksSessionStartMaxChars, DEFAULT_SESSION_START_MAX_CHARS);
});

test('control hooks.sessionStart: repo wins over user, friendly spellings normalized', () => {
  const r = resolveControl({
    repoConfig: { 'hooks.sessionStart': 'MAP' },
    userConfig: { 'hooks.sessionStart': 'index' },
    connection: NO_CONN,
  });
  assert.equal(r.hooksSessionStart, 'map');
  assert.equal(normalizeSessionStartMode('toc'), 'map');
  assert.equal(normalizeSessionStartMode('list'), 'index');
  assert.equal(normalizeSessionStartMode('both'), 'hybrid');
  assert.equal(normalizeSessionStartMode('nonsense'), null);
});

test('control hooks.sessionStart: user fallback; an invalid mode degrades to hybrid', () => {
  assert.equal(
    resolveControl({ userConfig: { 'hooks.sessionStart': 'map' }, connection: NO_CONN }).hooksSessionStart,
    'map',
  );
  // A mistyped shape must never blank the injection.
  assert.equal(
    resolveControl({ repoConfig: { 'hooks.sessionStart': 'nonsense' }, connection: NO_CONN }).hooksSessionStart,
    'hybrid',
  );
});

test('control hooks.sessionStart: maxChars is clamped, not rejected', () => {
  const at = (cfg) => resolveControl({ repoConfig: cfg, connection: NO_CONN }).hooksSessionStartMaxChars;
  assert.equal(at({ 'hooks.sessionStart.maxChars': 800 }), 800);
  assert.equal(at({ 'hooks.sessionStart.maxChars': '800' }), 800, 'hand-edited JSON strings are read');
  assert.equal(at({ 'hooks.sessionStart.maxChars': 12 }), MIN_SESSION_START_MAX_CHARS, 'a tiny budget clamps up');
  assert.equal(at({ 'hooks.sessionStart.maxChars': 1500000 }), MAX_SESSION_START_MAX_CHARS, 'a typo clamps down');
  // Unusable values fall back to the default rather than throwing — every read
  // command calls this resolver, including ones that never inject anything.
  for (const bad of [null, undefined, '', 'lots', {}, []]) {
    assert.equal(at({ 'hooks.sessionStart.maxChars': bad }), DEFAULT_SESSION_START_MAX_CHARS, `${JSON.stringify(bad)}`);
  }
});

test('control hooks.sessionStart: a declared-but-garbage repo budget still beats the user layer', () => {
  // The `ttl.default` rule. Choosing the layer on the PARSED value would let a
  // typo'd project policy silently become a per-machine one, so two developers
  // on the same commit would get different blocks and neither could tell why.
  const r = resolveControl({
    repoConfig: { 'hooks.sessionStart.maxChars': 'nine hundred' },
    userConfig: { 'hooks.sessionStart.maxChars': 400 },
    connection: NO_CONN,
  });
  assert.equal(r.hooksSessionStartMaxChars, DEFAULT_SESSION_START_MAX_CHARS);

  // An ABSENT repo key does fall through — only a declared one claims it.
  const fellThrough = resolveControl({
    userConfig: { 'hooks.sessionStart.maxChars': 400 },
    connection: NO_CONN,
  });
  assert.equal(fellThrough.hooksSessionStartMaxChars, 400);
});
