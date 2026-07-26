// `lorekit doctor` skill discovery: the check must find the skill whether it
// was installed into the project (.claude/skills) or globally (~/.claude/skills).
//
// Regression guard for the dogfood finding: a `lorekit install --global` writes
// the skill under ~/.claude, but doctor used to only look in the project dir, so
// it reported a perfectly healthy global install as "skill … not found". These
// tests spawn the real binary in `--mode off` (no network) and assert the skill
// status line for each install location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/install.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Run doctor offline (`--mode off` skips connectivity) with an isolated HOME so
// the global skill dir resolves into our temp home, never the real ~/.claude.
function runDoctor(dir, home) {
  return spawnSync(process.execPath, [BIN, 'doctor', '--mode', 'off', '--dir', dir], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home },
  });
}

// The single "skill lorekit-memory" status line from doctor's output.
const skillLine = (stdout) =>
  stdout.split('\n').find((l) => l.includes('skill lorekit-memory')) ?? '';

// Install with HOME pinned to `home` (global install targets homeDir()).
async function installWith(opts, home) {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await install(opts);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

test('doctor finds a project-installed skill', async () => {
  const root = tmp('lk-doc-proj-');
  const home = tmp('lk-doc-home-'); // empty home — skill lives only in the project
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }, home);

  const res = runDoctor(root, home);
  const line = skillLine(res.stdout);
  assert.match(line, /PASS/, `expected skill PASS, got: ${line}`);
  assert.doesNotMatch(line, /not found/);
});

test('doctor finds a GLOBAL-installed skill (regression: was reported "not found")', async () => {
  const home = tmp('lk-doc-ghome-');
  const root = tmp('lk-doc-gcwd-'); // empty project — skill lives only under ~/.claude
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true }, home);

  // Sanity: the skill really is only in the global location, not the project.
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));

  const res = runDoctor(root, home);
  const line = skillLine(res.stdout);
  assert.match(line, /PASS/, `global skill should be found, got: ${line}`);
  assert.doesNotMatch(line, /not found/);
});

test('doctor reports the skill missing when it is installed nowhere (and exits non-zero)', () => {
  const root = tmp('lk-doc-none-');
  const home = tmp('lk-doc-nhome-');

  const res = runDoctor(root, home);
  const line = skillLine(res.stdout);
  assert.match(line, /FAIL/, `expected skill FAIL, got: ${line}`);
  assert.match(line, /not found/);
  assert.equal(res.status, 1, 'a missing skill makes doctor exit non-zero');
});
