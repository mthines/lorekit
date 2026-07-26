// End-to-end smoke test: `npx @lorekit/cli install` must wire hooks that stay
// runnable after npx exits.
//
// The bug this guards against: npx stages the package's own `lorekit` bin into
// an ephemeral …/_npx/<hash>/node_modules/.bin dir and prepends it to PATH for
// the lifetime of the `npx @lorekit/cli install` process. `install` used to see
// that and wire hooks as a bare `lorekit hook …`, which then vanished with the
// npx cache — so Claude Code failed every hook with `lorekit: command not
// found`. A unit test can fake the PATH, but only a real `npm pack` + `npx`
// round-trip proves the *packaged* CLI behaves under real npx staging.
//
// Not named *.test.mjs on purpose: it does `npm pack` and spawns npx (slow,
// heavier than the unit suite), so it runs as its own explicit step, not under
// the `node --test test/*.test.mjs` glob.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-smoke-'));
const projDir = path.join(workdir, 'project');
fs.mkdirSync(projDir, { recursive: true });

let tarball;
try {
  // 1. Pack the CLI exactly as it would be published.
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', workdir], {
    cwd: cliRoot,
    encoding: 'utf8',
  }).trim().split('\n').pop().trim();
  tarball = path.join(workdir, packed);
  assert.ok(fs.existsSync(tarball), `npm pack produced no tarball (got "${packed}")`);
  console.log(`packed → ${path.basename(tarball)}`);

  // 2. Install THROUGH npx so the CLI's own `lorekit` bin is staged on PATH —
  //    the exact condition that made install pick a bare `lorekit` hook runner.
  execFileSync(
    'npx',
    [
      '-y',
      '--package',
      tarball,
      'lorekit',
      'install',
      '--project',
      '--yes',
      '--force',
      '--dir',
      projDir,
      '--endpoint',
      'https://example.test/functions/v1/mcp',
      '--token',
      'lk_rw_smoketestplaceholder',
    ],
    { stdio: 'inherit' },
  );

  // 3. The wired hooks must be reachable in a plain shell (npx form), never a
  //    bare `lorekit` that only resolved inside the transient npx PATH.
  const settingsPath = path.join(projDir, '.claude', 'settings.json');
  assert.ok(fs.existsSync(settingsPath), 'install did not write .claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  const commands = Object.values(settings.hooks || {})
    .flat()
    .flatMap((group) => (group && Array.isArray(group.hooks) ? group.hooks : []))
    .map((h) => h && h.command)
    .filter((cmd) => typeof cmd === 'string' && /\blorekit hook\b|@lorekit\/cli hook\b/.test(cmd));

  assert.ok(commands.length > 0, 'no lorekit hooks were wired');

  const bareRunner = commands.filter((cmd) => /^\s*lorekit hook\b/.test(cmd));
  assert.equal(
    bareRunner.length,
    0,
    `hooks wired to a bare \`lorekit\` (unresolvable once npx exits):\n${bareRunner.join('\n')}`,
  );
  for (const cmd of commands) {
    assert.match(cmd, /^npx -y @lorekit\/cli hook\b/, `unexpected hook runner: ${cmd}`);
  }

  console.log(`OK — ${commands.length} hook(s) wired via npx:`);
  for (const cmd of commands) console.log(`  ${cmd}`);
} finally {
  // The temp project holds only placeholder creds; clean it up either way.
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log('smoke-npx-install: PASS');
