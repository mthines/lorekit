// `lorekit uninstall` — reverses install for project / global scope, touching
// only lorekit's own skill, MCP entry, and hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../src/install.mjs';
import { uninstall } from '../src/uninstall.mjs';
import { withHome } from './helpers.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

test('uninstall --project removes skill, MCP entry, and hooks', async () => {
  const root = tmp('lk-uninst-proj-');
  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });

  // Sanity: install put everything in place.
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.mcp.json')));
  assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')));

  const code = await uninstall({ dir: root, yes: true, project: true });
  assert.equal(code, 0);

  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory')), 'skill dir gone');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-setup')), 'lorekit-setup skill dir gone');

  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(!mcp.mcpServers?.lorekit, 'lorekit server removed');

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const cmds = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(!cmds.some((cmd) => /lorekit(\/cli)? hook/.test(cmd)), 'no lorekit hooks left');
});

test('uninstall preserves other MCP servers and non-lorekit hooks + settings', async () => {
  const root = tmp('lk-uninst-preserve-');
  // Seed unrelated project config first.
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
  );
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }),
  );

  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });
  await uninstall({ dir: root, yes: true, project: true });

  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(!mcp.mcpServers.lorekit, 'lorekit removed');
  assert.ok(mcp.mcpServers.other, 'other server preserved');

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus', 'unrelated settings preserved');
  const startCmds = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(startCmds.includes('echo hi'), 'pre-existing hook preserved');
  assert.ok(!startCmds.some((cmd) => /lorekit(\/cli)? hook/.test(cmd)), 'lorekit hook stripped');
});

test('uninstall --global removes from ~/.claude, leaving user config intact', async () => {
  const home = tmp('lk-uninst-home-');
  const root = tmp('lk-uninst-cwd-');
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }),
  );

  await withHome(home, async () => {
    await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true });
    const code = await uninstall({ dir: root, yes: true, global: true });
    assert.equal(code, 0);

    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'lorekit-memory')), 'global skill gone');

    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.theme, 'dark', 'unrelated user settings preserved');
    assert.ok(cfg.mcpServers.other, 'other server preserved');
    assert.ok(!cfg.mcpServers.lorekit, 'lorekit server removed');

    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const cmds = Object.values(settings.hooks ?? {})
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(!cmds.some((cmd) => /lorekit(\/cli)? hook/.test(cmd)), 'global hooks removed');
  });
});

test('uninstall --global also clears the committable project .mcp.json from --mcp-json', async () => {
  // `install --global --mcp-json` writes BOTH ~/.claude.json and a project
  // .mcp.json, so a global uninstall must clear the project one too or it
  // orphans a lorekit server pointing at a torn-down setup.
  const home = tmp('lk-uninst-webhome-');
  const root = tmp('lk-uninst-webcwd-');
  await withHome(home, async () => {
    await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true, 'mcp-json': true });
    assert.ok(fs.existsSync(path.join(root, '.mcp.json')), 'web .mcp.json written by install');

    const code = await uninstall({ dir: root, yes: true, global: true });
    assert.equal(code, 0);

    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.ok(!cfg.mcpServers?.lorekit, 'global lorekit server removed');

    const web = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.ok(!web.mcpServers?.lorekit, 'orphaned project lorekit server also removed');
  });
});

test('uninstall --global preserves other servers in the project .mcp.json', async () => {
  // The web .mcp.json clear must be surgical — a co-located non-lorekit server
  // survives, exactly as the scope-config removal does.
  const home = tmp('lk-uninst-webhome2-');
  const root = tmp('lk-uninst-webcwd2-');
  await withHome(home, async () => {
    await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true, 'mcp-json': true });
    const file = path.join(root, '.mcp.json');
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
    seeded.mcpServers.other = { command: 'x' };
    fs.writeFileSync(file, JSON.stringify(seeded));

    await uninstall({ dir: root, yes: true, global: true });
    const web = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!web.mcpServers?.lorekit, 'lorekit removed');
    assert.ok(web.mcpServers?.other, 'unrelated server preserved');
  });
});

test('uninstall --global leaves an unrelated embedded-token project .mcp.json intact', async () => {
  // The global-uninstall cleanup must remove ONLY the committable web form, not
  // an embedded-token `install --project` entry a user set up separately.
  const home = tmp('lk-uninst-embed-home-');
  const root = tmp('lk-uninst-embed-cwd-');
  await withHome(home, async () => {
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', `${ENDPOINT}?token=${TOKEN}`] } },
      }),
    );
    await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true });
    await uninstall({ dir: root, yes: true, global: true });

    const proj = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.ok(proj.mcpServers?.lorekit, 'embedded-token project entry preserved by a global uninstall');
    assert.ok(
      proj.mcpServers.lorekit.args.some((a) => a.includes(TOKEN)),
      'it is still the embedded-token form, untouched',
    );
  });
});

test('uninstall leaves a corrupt config untouched, still removes what it can, and exits non-zero', async () => {
  const root = tmp('lk-uninst-corrupt-');
  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });

  // Corrupt the .mcp.json after a clean install.
  const mcpFile = path.join(root, '.mcp.json');
  const corrupt = '{ not json';
  fs.writeFileSync(mcpFile, corrupt);

  const code = await uninstall({ dir: root, yes: true, project: true });
  assert.equal(code, 1, 'non-zero exit when a target could not be removed');

  // The unparseable file is byte-for-byte untouched, never clobbered.
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), corrupt, 'corrupt .mcp.json left as-is');

  // The other targets were still removed — one bad file does not block the rest.
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory')), 'skill still removed');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const cmds = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(!cmds.some((cmd) => /lorekit(\/cli)? hook/.test(cmd)), 'hooks still removed');
});

test('uninstall leaves no leftover temp files', async () => {
  const root = tmp('lk-uninst-tmp-');
  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });
  await uninstall({ dir: root, yes: true, project: true });
  const leftovers = fs.readdirSync(path.join(root, '.claude')).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no .tmp remnants from atomic writes');
});

test('uninstall is idempotent and a no-op when nothing is installed', async () => {
  const root = tmp('lk-uninst-noop-');
  const code = await uninstall({ dir: root, yes: true, project: true });
  assert.equal(code, 0, 'exits clean with nothing to remove');
  assert.ok(!fs.existsSync(path.join(root, '.mcp.json')), 'no file created by a no-op uninstall');

  // Running after a real install twice is safe.
  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });
  await uninstall({ dir: root, yes: true, project: true });
  const second = await uninstall({ dir: root, yes: true, project: true });
  assert.equal(second, 0, 'second uninstall is a clean no-op');
});
