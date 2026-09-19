// The throttled SessionStart skill-update drift nudge (`core/update-notify.mjs`)
// and the `updates.notify` control key it is gated by.
//
// Covers: nudges once, stays silent on repeat within the 7-day cooldown, fires
// again once the cooldown elapses (a fresh Date.now(), no real waiting), and
// stays fully silent — never touching the throttle file — when
// `updates.notify` is `off`. Also exercises the real SessionStart hook path
// end-to-end so the wiring in `commands/hook.mjs` is covered, not just the
// pure resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/commands/install.mjs';
import { SKILLS } from '../src/shared/config.mjs';
import {
  resolveUpdateNudge,
  updateStatePath,
  readUpdateState,
} from '../src/core/update-notify.mjs';
import { normalizeUpdateNotifyMode } from '../src/shared/control.mjs';
import { parseSkillVersion } from '../src/shared/skill-versions.mjs';
import { withHome } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Read the REAL shipped version rather than hardcoding it — the guard added in
// scripts/ci/skill-version-guard.mjs means this bumps on every content change
// to lorekit-memory, and a hardcoded string here would silently stop matching
// the very drift signal these tests exist to exercise.
const SHIPPED_MEMORY_VERSION = parseSkillVersion(
  fs.readFileSync(path.join(SKILLS.find((s) => s.name === 'lorekit-memory').source, 'SKILL.md'), 'utf8'),
);
const shippedVersionRe = () => new RegExp(`v${SHIPPED_MEMORY_VERSION.replace(/\./g, '\\.')}`);

// A project with an OUTDATED lorekit-memory install (project-scoped) and an
// empty `home` — no global install to add noise to the drift signature.
async function outdatedProject() {
  const root = tmp('lk-notify-root-');
  const home = tmp('lk-notify-installhome-');
  await withHome(home, () => install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }));
  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  const body = fs
    .readFileSync(skillMd, 'utf8')
    .replace(`version: '${SHIPPED_MEMORY_VERSION}'`, "version: '0.1.0'");
  assert.notEqual(body, fs.readFileSync(skillMd, 'utf8'), 'precondition — downgrade must actually change the file');
  fs.writeFileSync(skillMd, body);
  return { root, home };
}

// A project with a LEGACY lorekit-memory install whose SKILL.md frontmatter
// has no parseable `version:` line at all — `checkSkillVersions` classifies
// this as `unknown`, not `outdated` (see `shared/skill-versions.mjs`).
async function unknownVersionProject() {
  const root = tmp('lk-notify-unknown-root-');
  const home = tmp('lk-notify-unknown-installhome-');
  await withHome(home, () => install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }));
  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  const versionLineRe = new RegExp(`^[ \\t]*version: '${SHIPPED_MEMORY_VERSION.replace(/\./g, '\\.')}'\\n`, 'm');
  const body = fs.readFileSync(skillMd, 'utf8').replace(versionLineRe, '');
  assert.notEqual(body, fs.readFileSync(skillMd, 'utf8'), 'precondition — the version line must actually be removed');
  fs.writeFileSync(skillMd, body);
  return { root, home };
}

test('normalizeUpdateNotifyMode accepts the forgiving vocabulary', () => {
  assert.equal(normalizeUpdateNotifyMode('auto'), 'auto');
  assert.equal(normalizeUpdateNotifyMode('on'), 'auto');
  assert.equal(normalizeUpdateNotifyMode(true), 'auto');
  assert.equal(normalizeUpdateNotifyMode('off'), 'off');
  assert.equal(normalizeUpdateNotifyMode('disabled'), 'off');
  assert.equal(normalizeUpdateNotifyMode(false), 'off');
  assert.equal(normalizeUpdateNotifyMode('bogus'), null);
});

test('resolveUpdateNudge fires once for a genuinely outdated install', async () => {
  const { root, home } = await outdatedProject();
  const notifyHome = tmp('lk-notify-state-');
  await withHome(home, () => {
    const nudge = resolveUpdateNudge(root, { notify: 'auto', now: 1_000, env: { LOREKIT_HOME: notifyHome } });
    assert.match(nudge, /outdated/i);
    assert.match(nudge, /lorekit-memory/);
    assert.match(nudge, /v0\.1\.0/);
    assert.match(nudge, shippedVersionRe());
    assert.match(nudge, /lorekit update/);

    // The throttle state was actually recorded, not just the return value.
    const state = readUpdateState(updateStatePath({ LOREKIT_HOME: notifyHome }));
    assert.equal(state.lastNotifiedVersion, `lorekit-memory@${SHIPPED_MEMORY_VERSION}`);
    assert.equal(state.lastNotifiedAt, 1_000);
  });
});

test('resolveUpdateNudge still fires (and records the throttle) for an `unknown` legacy install', async () => {
  // Regression: `formatUpdateNudge` used to filter to rows carrying BOTH an
  // installed AND a shipped version, so a legacy install with no parseable
  // version at all (`unknown` state — installed=null) was silently dropped
  // from the headline. When it was the ONLY drifted skill, formatUpdateNudge
  // returned null, which made `resolveUpdateNudge` bail out BEFORE writing
  // the throttle state — contradicting the very state this install most needs
  // surfaced.
  const { root, home } = await unknownVersionProject();
  const notifyHome = tmp('lk-notify-unknown-state-');
  await withHome(home, () => {
    const nudge = resolveUpdateNudge(root, { notify: 'auto', now: 1_000, env: { LOREKIT_HOME: notifyHome } });
    assert.match(nudge, /outdated/i);
    assert.match(nudge, /lorekit-memory/);
    assert.match(nudge, /lorekit update/);
    assert.doesNotMatch(nudge, /v\d.*→/, 'no installed version is known, so no "vX →" should be printed');

    // The throttle state was actually recorded — this is the assertion that
    // fails without the fix, since the old code returned null before reaching
    // writeUpdateState at all.
    const state = readUpdateState(updateStatePath({ LOREKIT_HOME: notifyHome }));
    assert.equal(state.lastNotifiedVersion, `lorekit-memory@${SHIPPED_MEMORY_VERSION}`);
    assert.equal(state.lastNotifiedAt, 1_000);
  });
});

test('resolveUpdateNudge returns null when nothing is outdated', async () => {
  const root = tmp('lk-notify-current-root-');
  const home = tmp('lk-notify-current-home-');
  await withHome(home, () => install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }));

  const notifyHome = tmp('lk-notify-current-state-');
  await withHome(home, () => {
    const nudge = resolveUpdateNudge(root, { notify: 'auto', now: 1_000, env: { LOREKIT_HOME: notifyHome } });
    assert.equal(nudge, null);
    // Negative-assertion proof: this is the branch that must fail if the
    // `if (!signature) return null;` early-return in resolveUpdateNudge were
    // ever dropped — formatUpdateNudge would then be asked to format an empty
    // "needing" list, which returns null too, but the state file would still
    // get WRITTEN with an empty signature on every current-only session.
    // Verified by hand: removing that early return makes this next assertion
    // fail (the file gets created for a fully-current install).
    assert.equal(fs.existsSync(updateStatePath({ LOREKIT_HOME: notifyHome })), false);
  });
});

test('resolveUpdateNudge stays silent on repeat within the 7-day cooldown', async () => {
  const { root, home } = await outdatedProject();
  const notifyHome = tmp('lk-notify-cooldown-state-');
  const env = { LOREKIT_HOME: notifyHome };

  await withHome(home, () => {
    const first = resolveUpdateNudge(root, { notify: 'auto', now: 1_000, env });
    assert.notEqual(first, null, 'precondition — the first call must nudge');

    const second = resolveUpdateNudge(root, { notify: 'auto', now: 1_000 + 60_000, env });
    assert.equal(second, null, 'the same drift signature inside the cooldown must stay silent');

    // The throttle state must not have been overwritten by the silent call.
    const state = readUpdateState(updateStatePath(env));
    assert.equal(state.lastNotifiedAt, 1_000);
  });
});

test('resolveUpdateNudge fires again once the 7-day cooldown elapses', async () => {
  const { root, home } = await outdatedProject();
  const notifyHome = tmp('lk-notify-elapsed-state-');
  const env = { LOREKIT_HOME: notifyHome };

  await withHome(home, () => {
    resolveUpdateNudge(root, { notify: 'auto', now: 1_000, env });
    const later = resolveUpdateNudge(root, { notify: 'auto', now: 1_000 + SEVEN_DAYS_MS + 1, env });
    assert.notEqual(later, null, 'the cooldown must have elapsed by now');

    const state = readUpdateState(updateStatePath(env));
    assert.equal(state.lastNotifiedAt, 1_000 + SEVEN_DAYS_MS + 1, 'the throttle record must have advanced');
  });
});

test('resolveUpdateNudge with notify "off" stays silent and never touches the state file', async () => {
  const { root, home } = await outdatedProject();
  const notifyHome = tmp('lk-notify-off-state-');
  const env = { LOREKIT_HOME: notifyHome };

  await withHome(home, () => {
    const nudge = resolveUpdateNudge(root, { notify: 'off', now: 1_000, env });
    assert.equal(nudge, null);
  });

  // Negative-assertion proof: this must fail if the `notify === 'off'` guard
  // in resolveUpdateNudge were removed (or moved after the filesystem check),
  // since the outdated project above would otherwise cause a nudge and a
  // write. Verified by hand while authoring: deleting the guard's early
  // return makes this assertion fail (the file gets created).
  assert.equal(fs.existsSync(updateStatePath(env)), false, '"off" must never create the throttle file');
});

// ── end-to-end via the real hook binary ──────────────────────────────────────

// `CLAUDE_PLUGIN_DATA` gives each invocation its own session-marker directory
// (`core/state.mjs`'s `firstTimeThisSession`) — WITHOUT it every call shares
// the process-wide default (`os.tmpdir()/lorekit-hooks`), keyed only by
// `sessionId:tag`. A session id reused across ANY earlier run (this suite, a
// manual invocation, another test file) would then read as "already seen" and
// the SessionStart branch would silently emit nothing — exactly the failure
// mode `hook.integration.test.mjs`'s own `freshStateDir()` exists to avoid.
function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-notify-hookstate-'));
}

function runHook({ dir, home, sessionId }) {
  return execFileSync('node', [BIN, 'hook', '--adapter', 'claude', '--event', 'SessionStart', '--dir', dir], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: dir }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOREKIT_HOME: home,
      CLAUDE_PLUGIN_DATA: freshStateDir(),
      // `local`, not `off`: `hook.mjs` returns before the SessionStart branch
      // entirely when `control.mode === 'off'`, which would skip the update
      // nudge along with everything else. `local` reaches the branch with an
      // empty (but usable) store, which is all the drift check itself needs —
      // it is a pure filesystem read regardless of store mode.
      LOREKIT_MODE: 'local',
    },
  });
}

test('SessionStart hook appends the update nudge exactly once per cooldown window', async () => {
  const { root, home } = await outdatedProject();

  const first = runHook({ dir: root, home, sessionId: 'nudge-1' });
  const firstOut = JSON.parse(first).hookSpecificOutput.additionalContext;
  assert.match(firstOut, /LoreKit skills are outdated/);
  assert.match(firstOut, /lorekit update/);

  // A second session, immediately after: still inside the cooldown, so the
  // hook's OWN wiring (not just the resolver in isolation) must suppress it.
  // The store is otherwise empty (no lessons, no custom instruction), so a
  // throttled nudge means the hook emits NOTHING at all — `emit()` only
  // writes when there is text — rather than a JSON body with an empty field,
  // which is why this checks the raw stdout rather than parsing it as JSON.
  const second = runHook({ dir: root, home, sessionId: 'nudge-2' });
  assert.doesNotMatch(second, /LoreKit skills are outdated/);
});

test('SessionStart hook stays silent when updates.notify is off in .lorekit.json', async () => {
  const { root, home } = await outdatedProject();
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'updates.notify': 'off' }));

  // Same reasoning as the cooldown test above: with `updates.notify: off` and
  // an otherwise-empty store, the hook emits nothing at all rather than a JSON
  // body with an empty field — check the raw stdout, don't assume it parses.
  const out = runHook({ dir: root, home, sessionId: 'nudge-off-1' });
  assert.doesNotMatch(out, /LoreKit skills are outdated/);
  assert.equal(fs.existsSync(path.join(home, 'update-state.json')), false, '"off" must never create the throttle file');
});
