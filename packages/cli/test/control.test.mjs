// Control-model resolver tests: mode selection, precedence, and deny-wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveControl, normalizeMode } from '../src/control.mjs';

const USABLE = { usable: true, endpoint: 'https://ref.supabase.co/functions/v1/mcp', token: 'lk_rw_x' };
const NO_CONN = { usable: false, endpoint: null, token: null };

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
  });
  assert.equal(r.mode, 'local');
  assert.notEqual(r.mode, 'remote');
  assert.ok(r.denies.some((d) => d.mode === 'remote'));
  assert.equal(r.storeTarget, '/proj/.lore');
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

test('LOREKIT_STORE / config store dir override the default .lore path', () => {
  const abs = resolveControl({ env: { LOREKIT_MODE: 'local', LOREKIT_STORE: '/abs/lore' }, root: '/p' });
  assert.equal(abs.storeTarget, '/abs/lore');
  const rel = resolveControl({ env: { LOREKIT_MODE: 'local', LOREKIT_STORE: 'mem' }, root: '/p' });
  assert.equal(rel.storeTarget, '/p/mem');
});
