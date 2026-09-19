// `lorekit update` + doctor's version-aware skill reporting.
//
// Covers: doctor warning (not failing) on an outdated skill install, `update`
// refreshing an outdated install back to the shipped version, `update` being
// idempotent once current, and `--check` reporting drift without writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/commands/install.mjs';
import { update } from '../src/commands/update.mjs';
import { SKILLS } from '../src/shared/config.mjs';
import { checkSkillVersions, parseSkillVersion } from '../src/shared/skill-versions.mjs';
import { setWriters } from '../src/shared/util.mjs';
import { withHome } from './helpers.mjs';

// Read the REAL shipped version rather than hardcoding it — the guard added in
// scripts/ci/skill-version-guard.mjs means this bumps on every content change
// to lorekit-memory, and a hardcoded string here would silently stop matching
// the drift signal these tests downgrade FROM.
const SHIPPED_MEMORY_VERSION = parseSkillVersion(
  fs.readFileSync(path.join(SKILLS.find((s) => s.name === 'lorekit-memory').source, 'SKILL.md'), 'utf8'),
);

// Capture `log`/`status`/`heading` output around one call, restoring the real
// writers afterward even on throw — the same pattern `obligations.test.mjs`
// uses, since `node --test` runs each file in a child process sharing the
// runner's own stdout (a global `process.stdout.write` hijack would swallow
// the runner's result lines).
function capture(run) {
  let out = '';
  const restore = setWriters({ out: (s) => { out += s; } });
  return Promise.resolve(run()).then(
    (result) => { restore(); return { result, out }; },
    (e) => { restore(); throw e; },
  );
}

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function runDoctor(dir, home) {
  return spawnSync(process.execPath, [BIN, 'doctor', '--mode', 'off', '--dir', dir], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home },
  });
}

const skillLineFor = (stdout, name) =>
  stdout.split('\n').find((l) => l.includes(`skill ${name}`)) ?? '';

// `install`/`update` resolve the global scope through `homeDir()`, which reads
// the env at call time — an in-process call (unlike the spawned `runDoctor`
// above, which passes `env` directly) needs the `withHome` wrapper instead.

async function installProject(root, home) {
  return withHome(home, () =>
    install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }),
  );
}

// Downgrade an already-installed skill's version stamp, simulating an install
// that predates the CLI's current shipped version.
function downgrade(skillMdPath, from, to) {
  const body = fs.readFileSync(skillMdPath, 'utf8');
  const patched = body.replace(new RegExp(`version: '${from}'`), `version: '${to}'`);
  assert.notEqual(patched, body, `expected to find version: '${from}' in ${skillMdPath}`);
  fs.writeFileSync(skillMdPath, patched);
}

test('doctor warns (not fails) when an installed skill is outdated', async () => {
  const root = tmp('lk-upd-doc-root-');
  const home = tmp('lk-upd-doc-home-');
  await installProject(root, home);

  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  downgrade(skillMd, SHIPPED_MEMORY_VERSION, '0.1.0');

  const res = runDoctor(root, home);
  const line = skillLineFor(res.stdout, 'lorekit-memory');
  assert.match(line, /WARN/, `expected WARN, got: ${line}`);
  assert.match(line, /v0\.1\.0/, `expected the installed version quoted, got: ${line}`);
  assert.match(line, new RegExp(`v${SHIPPED_MEMORY_VERSION.replace(/\./g, '\\.')}`), `expected the shipped version quoted, got: ${line}`);
  assert.match(line, /lorekit update/, `expected the fix pointer, got: ${line}`);
  // A warn must not flip doctor's exit code — only a fail does.
  assert.equal(res.status, 0, `outdated skill must warn, not fail doctor: ${res.stdout}`);
});

test('doctor still passes a current, up-to-date skill install', async () => {
  const root = tmp('lk-upd-doc-current-root-');
  const home = tmp('lk-upd-doc-current-home-');
  await installProject(root, home);

  const res = runDoctor(root, home);
  const line = skillLineFor(res.stdout, 'lorekit-memory');
  assert.match(line, /PASS/, `expected PASS on a fresh install, got: ${line}`);
  assert.doesNotMatch(line, /outdated/);
});

test('update refreshes an outdated skill install back to the shipped version', async () => {
  const root = tmp('lk-upd-root-');
  const home = tmp('lk-upd-home-');
  await installProject(root, home);

  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  downgrade(skillMd, SHIPPED_MEMORY_VERSION, '0.1.0');

  await withHome(home, async () => {
    // sanity — genuinely outdated before update runs.
    const before = checkSkillVersions(root).find((r) => r.scope === 'project' && r.name === 'lorekit-memory');
    assert.equal(before.state, 'outdated');

    const res = await update({ dir: root, project: true });
    assert.equal(res.exitCode, 0);
    assert.ok(res['lorekit.cli.update.outdated'] >= 1, 'expected at least the downgraded skill to be reported');

    const after = checkSkillVersions(root).find((r) => r.scope === 'project' && r.name === 'lorekit-memory');
    assert.equal(after.state, 'current');
    assert.equal(after.installed, after.shipped);
  });
});

test('update is idempotent once every installed skill is current', async () => {
  const root = tmp('lk-upd-idem-root-');
  const home = tmp('lk-upd-idem-home-');
  await installProject(root, home);

  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  downgrade(skillMd, SHIPPED_MEMORY_VERSION, '0.1.0');

  await withHome(home, async () => {
    const first = await update({ dir: root, project: true });
    assert.ok(first['lorekit.cli.update.outdated'] >= 1);

    // Second run against an already-current install: nothing left to refresh.
    const second = await update({ dir: root, project: true });
    assert.equal(second['lorekit.cli.update.outdated'], 0, 'a second run must find nothing outdated');
  });
});

test('update --check reports drift without writing anything', async () => {
  const root = tmp('lk-upd-check-root-');
  const home = tmp('lk-upd-check-home-');
  await installProject(root, home);

  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  downgrade(skillMd, SHIPPED_MEMORY_VERSION, '0.1.0');
  const beforeBody = fs.readFileSync(skillMd, 'utf8');

  await withHome(home, async () => {
    const res = await update({ dir: root, project: true, check: true });
    assert.ok(res['lorekit.cli.update.outdated'] >= 1, 'expected --check to report the drift');
    assert.equal(res['lorekit.cli.update.check'], true);
  });

  // Negative-assertion proof: the whole point of --check is that this file is
  // untouched — removing the `if (dryRun) { ...; continue; }` guard in
  // update.mjs (so a --check run still calls copyDir) makes this assertion
  // fail, since the downgraded version stamp would be overwritten back to
  // the shipped version. Verified by hand while authoring.
  const afterBody = fs.readFileSync(skillMd, 'utf8');
  assert.equal(afterBody, beforeBody, '--check must never write to disk');
});

test('update with no --project/--global targets only scopes with an existing install', async () => {
  const root = tmp('lk-upd-scope-root-');
  const home = tmp('lk-upd-scope-home-'); // nothing installed globally
  await installProject(root, home); // project-only install

  const skillMd = path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md');
  downgrade(skillMd, SHIPPED_MEMORY_VERSION, '0.1.0');

  await withHome(home, async () => {
    const res = await update({ dir: root }); // neither flag passed
    assert.equal(res['lorekit.cli.update.scopes'], 1, 'only the project scope has an install to refresh');
    assert.ok(res['lorekit.cli.update.outdated'] >= 1);
  });

  // Global scope was never touched — no skills directory should exist there.
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'lorekit-memory')), false);
});

test('update reports nothing to do when no skill is installed anywhere', async () => {
  const root = tmp('lk-upd-none-root-');
  const home = tmp('lk-upd-none-home-');

  await withHome(home, async () => {
    const res = await update({ dir: root });
    assert.equal(res['lorekit.cli.update.scopes'], 0);
    assert.equal(res['lorekit.cli.update.outdated'], 0);
  });
});

test('update --project reports nothing to do when the project scope is empty', async () => {
  // Regression: `targetScopes` used to return `['project']` for an explicit
  // --project flag WITHOUT checking whether anything was actually installed
  // there, so an empty project scope fell through to the "every skill already
  // up to date" green message instead of the "nothing to update" report.
  // Negative-assertion proof: reverting `targetScopes` to `if (args.project)
  // return ['project'];` makes this assertion fail. Verified by hand.
  const home = tmp('lk-upd-empty-project-home-'); // nothing installed anywhere
  const emptyRoot = tmp('lk-upd-empty-project-root-');

  await withHome(home, async () => {
    const res = await update({ dir: emptyRoot, project: true });
    assert.equal(res['lorekit.cli.update.scopes'], 0, 'an empty --project scope must report nothing to update');
    assert.equal(res['lorekit.cli.update.outdated'], 0);
  });
});

test('update --global prefers the global scope over --project when both are passed', async () => {
  // Regression: `targetScopes` checked `args.project` before `args.global`,
  // the opposite order from `install`/`uninstall`, so `--project --global`
  // picked project — the one flag combination where the two commands could
  // disagree about which scope wins.
  const root = tmp('lk-upd-precedence-root-');
  const home = tmp('lk-upd-precedence-home-');
  await withHome(home, () =>
    install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true }),
  );

  await withHome(home, async () => {
    const res = await update({ dir: root, project: true, global: true });
    assert.equal(res['lorekit.cli.update.scopes'], 1, 'global has an install, project does not');
  });
});

test('update removes a file the shipped skill no longer ships', async () => {
  // Regression: `copyDir` only ever writes, so a rule/reference file dropped
  // from a newer skill version survived every future `update` forever while
  // `update` still reported a clean refresh. Negative-assertion proof:
  // removing the `pruneRemoved` call before `copyDir` makes this assertion
  // fail. Verified by hand.
  const root = tmp('lk-upd-prune-root-');
  const home = tmp('lk-upd-prune-home-');
  await installProject(root, home);

  const skillDir = path.join(root, '.claude', 'skills', 'lorekit-memory');
  const staleFile = path.join(skillDir, 'rules', 'removed-in-newer-version.md');
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, '# stale content the shipped skill no longer has\n');

  const skillMd = path.join(skillDir, 'SKILL.md');
  downgrade(skillMd, SHIPPED_MEMORY_VERSION, '0.1.0'); // force `update` to actually touch this skill

  await withHome(home, async () => {
    await update({ dir: root, project: true });
  });

  assert.equal(fs.existsSync(staleFile), false, 'update must prune content the shipped skill no longer ships');
});

test('update --check previews the file a real run would prune', async () => {
  // Regression: `--check` skipped `pruneRemoved` entirely, so the dry run
  // never named the one destructive step the real run takes. Negative-
  // assertion proof: passing `{ dryRun: false }` (or omitting the option) to
  // the `pruneRemoved` call in the dry-run branch makes this assertion fail —
  // the count would come back 0 AND the stale file would be deleted despite
  // `--check`. Verified by hand.
  const root = tmp('lk-upd-check-prune-root-');
  const home = tmp('lk-upd-check-prune-home-');
  await installProject(root, home);

  const skillDir = path.join(root, '.claude', 'skills', 'lorekit-memory');
  const staleFile = path.join(skillDir, 'rules', 'removed-in-newer-version.md');
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, '# stale content the shipped skill no longer has\n');
  downgrade(path.join(skillDir, 'SKILL.md'), SHIPPED_MEMORY_VERSION, '0.1.0');

  await withHome(home, async () => {
    const { result, out } = await capture(() => update({ dir: root, project: true, check: true }));
    assert.ok(result['lorekit.cli.update.outdated'] >= 1);
    assert.match(out, /1 to remove/, `expected the preview count in the check output, got: ${out}`);
  });

  // `--check` still writes nothing — the preview must be read-only.
  assert.equal(fs.existsSync(staleFile), true, '--check must not actually prune');
});

test('update --check exits non-zero when it finds drift, and 0 when everything is current', async () => {
  // Regression: `--check` always returned exitCode 0, so nothing could gate a
  // pipeline on "every installed skill is current" — a stale install and a
  // healthy one were indistinguishable to a calling script. Negative-
  // assertion proof: hardcoding `exitCode: 0` in `update.mjs`'s return makes
  // the first assertion below fail. Verified by hand.
  const root = tmp('lk-upd-check-exit-root-');
  const home = tmp('lk-upd-check-exit-home-');
  await installProject(root, home);
  downgrade(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md'), SHIPPED_MEMORY_VERSION, '0.1.0');

  await withHome(home, async () => {
    const drifted = await update({ dir: root, project: true, check: true });
    assert.equal(drifted.exitCode, 1, '--check must exit non-zero when it finds drift');

    await update({ dir: root, project: true }); // real run — brings it current
    const clean = await update({ dir: root, project: true, check: true });
    assert.equal(clean.exitCode, 0, '--check must exit 0 once every skill is current');
  });
});

test('update reports a hook-wiring refresh even when no skill was outdated', async () => {
  // Regression: `upsertClaudeHooks` rewrites `.claude/settings.json`
  // unconditionally on every non-dry-run `update` (even reformatting it), but
  // the no-skills-outdated report said only "already at the shipped version"
  // — silent about the one file it just touched. Negative-assertion proof:
  // discarding `upsertClaudeHooks`'s return value instead of summing its
  // counts makes the `/hook wiring refreshed/` match below fail even though
  // the settings file is still rewritten underneath. Verified by hand.
  const root = tmp('lk-upd-hooks-root-');
  const home = tmp('lk-upd-hooks-home-');
  await installProject(root, home); // installs with hooks wired

  const settingsPath = path.join(root, '.claude', 'settings.json');
  // Perturb the hook command to a stale-but-still-recognized pin (bypassing
  // `install`) so a no-op-on-skills `update` still has real hook drift to
  // repair — it must still match `LOREKIT_HOOK_RE` (a bare `stale-runner …`
  // would not, and `installedHookEvents` would then treat the event as
  // unwired rather than drifted).
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.hooks.SessionStart[0].hooks[0].command =
    'npx -y @lorekit/cli@1.2.3 hook --adapter claude --event SessionStart --dir "${CLAUDE_PROJECT_DIR}"';
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  await withHome(home, async () => {
    const { result, out } = await capture(() => update({ dir: root, project: true }));
    assert.equal(result['lorekit.cli.update.outdated'], 0, 'no skill content was changed, only the hook command');
    assert.match(out, /hook wiring refreshed/, `expected the hook refresh to be reported, got: ${out}`);
  });
});
