// `lorekit install` scope: project (.claude + .mcp.json) vs global (~/.claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../src/install.mjs';
import { skillInstallDir, mcpConfigPath, homeDir } from '../src/config.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

test('path helpers resolve project vs global targets', () => {
  const root = '/repo';
  assert.equal(skillInstallDir(root, 'project'), path.join(root, '.claude', 'skills', 'lorekit-memory'));
  assert.equal(mcpConfigPath(root, 'project'), path.join(root, '.mcp.json'));

  assert.equal(skillInstallDir(root, 'global'), path.join(homeDir(), '.claude', 'skills', 'lorekit-memory'));
  assert.equal(mcpConfigPath(root, 'global'), path.join(homeDir(), '.claude.json'));

  // Scope defaults to project.
  assert.equal(skillInstallDir(root), skillInstallDir(root, 'project'));
});

test('install --project writes into the repo, not home', async () => {
  const root = tmp('lk-proj-');
  const code = await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });
  assert.equal(code, 0);

  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.lorekit, 'lorekit server wired into project .mcp.json');
  assert.ok(mcp.mcpServers.lorekit.args.some((a) => a.includes(ENDPOINT)));
});

test('install --global writes into ~/.claude and preserves existing user config', async () => {
  const home = tmp('lk-home-');
  const root = tmp('lk-cwd-');
  // Seed an existing ~/.claude.json with unrelated user state + another server.
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }),
  );

  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const code = await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true });
    assert.equal(code, 0);

    // Skill + server land under home, not the project.
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(root, '.mcp.json')), 'project .mcp.json not touched for a global install');

    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.theme, 'dark', 'unrelated user settings preserved');
    assert.ok(cfg.mcpServers.other, 'other MCP server preserved');
    assert.ok(cfg.mcpServers.lorekit, 'lorekit server added to ~/.claude.json');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
});
