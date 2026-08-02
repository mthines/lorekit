// `lorekit install` scope: project (.claude + .mcp.json) vs global (~/.claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, defaultHookMode, HOOK_PROMPT_OPTIONS } from '../src/install.mjs';
import { skillInstallDir, mcpConfigPath, homeDir, installedHookEvents, HOOK_MODES } from '../src/config.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// `install` returns the traceCommand result shape ({ exitCode, ...bounded attrs }),
// the same contract `doctor` uses, so tests read the code off that.
const exitOf = (result) => (result !== null && typeof result === 'object' ? result.exitCode : result);

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
  assert.equal(exitOf(code), 0);

  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  // Every skill the CLI ships is installed, not just the primary one.
  assert.ok(
    fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-setup', 'SKILL.md')),
    'lorekit-setup skill installed alongside lorekit-memory',
  );
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
    assert.equal(exitOf(code), 0);

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

test('install wires the three lifecycle hooks into project settings.json', async () => {
  const root = tmp('lk-hooks-');
  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'PostToolUseFailure', 'Stop']) {
    assert.ok(settings.hooks[event]?.length, `${event} hook group present`);
    const cmd = settings.hooks[event][0].hooks[0].command;
    assert.match(cmd, /lorekit(\/cli)? hook --adapter claude --event /);
    assert.match(cmd, new RegExp(`--event ${event}\\b`));
  }
});

test('install hook wiring is idempotent (no duplicate entries on re-run)', async () => {
  const root = tmp('lk-hooks-idem-');
  const opts = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  await install(opts);
  await install(opts);

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'PostToolUseFailure', 'Stop']) {
    assert.equal(settings.hooks[event].length, 1, `${event} not duplicated on re-run`);
  }
});

test('install --no-hooks skips the hooks but still installs skill + mcp', async () => {
  const root = tmp('lk-nohooks-');
  await install({ dir: root, endpoint: ENDPOINT, yes: true, project: true, 'no-hooks': true });

  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.mcp.json')));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.json')), 'no settings.json written with --no-hooks');
});

test('install preserves existing settings.json content and non-lorekit hooks', async () => {
  const root = tmp('lk-hooks-merge-');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }),
  );

  await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true });

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus', 'unrelated settings preserved');
  const cmds = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes('echo hi'), 'pre-existing hook preserved');
  assert.ok(cmds.some((cmd) => /lorekit(\/cli)? hook/.test(cmd)), 'lorekit hook added alongside');
});

test('global install writes hooks into ~/.claude/settings.json', async () => {
  const home = tmp('lk-hooks-home-');
  const root = tmp('lk-hooks-cwd-');
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true });
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('hook --adapter claude'));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.json')), 'project settings untouched for global install');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
});

test('install reports already-installed and exits 0 without --force on a complete install', async () => {
  const root = tmp('lk-already-');
  const opts = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  const firstCode = await install(opts);
  assert.equal(exitOf(firstCode), 0, 'first install succeeds');

  // Second run without --force: should be a graceful no-op exit 0.
  const secondCode = await install(opts);
  assert.equal(exitOf(secondCode), 0, 'second install exits 0');

  // Files are unchanged — skills and MCP server are still present.
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.lorekit, 'MCP server still wired after second install');
});

test('install reuses existing token from config when no token is passed', async () => {
  const root = tmp('lk-reuse-token-');
  // Pre-seed an .mcp.json with an existing token in the URL — simulates a
  // project that already has a token configured from a previous install.
  const existing = { mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', `${ENDPOINT}?token=${TOKEN}`] } } };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(existing));

  // Install without passing a token — the stored token should be picked up.
  await install({ dir: root, yes: true, project: true, force: true });
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.lorekit.args.some((a) => a.includes(TOKEN)), 'token reused from existing config');
});

test('install rejects on a corrupt settings.json instead of clobbering it', async () => {
  const root = tmp('lk-corrupt-');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json');
  // Fail-fast clobber-guard, same as a corrupt .mcp.json: abort with a parse
  // error rather than silently overwrite the user's settings.
  await assert.rejects(
    install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }),
    /Failed to parse/,
  );
});

// ── Hook wiring is an explicit choice ────────────────────────────────────────

test('install prompt offers the three hook modes and preselects all on a fresh install', () => {
  // The prompt itself needs a pty, so assert on the option set it is built from
  // plus the pure preselection rule — together those ARE the prompt's contract.
  assert.deepEqual(HOOK_PROMPT_OPTIONS.map((o) => o.value), HOOK_MODES);
  for (const option of HOOK_PROMPT_OPTIONS) {
    assert.ok(option.label && option.hint, `${option.value} option is labelled and hinted`);
    // No hook writes memory — they inject context and nudge. Copy that claims
    // otherwise asks for consent to something that does not happen.
    assert.doesNotMatch(option.hint, /write/i, `${option.value} hint does not claim writes`);
  }
  assert.equal(defaultHookMode({ freshInstall: true, wiredEvents: [] }), 'all');
});

test('install preselects the detected hook state on a re-install, not a constant', () => {
  // A user who declined must not have the hooks resurrected by a later re-run
  // (token refresh, --force, completing a partial install).
  assert.equal(defaultHookMode({ freshInstall: false, wiredEvents: [] }), 'none');
  assert.equal(defaultHookMode({ freshInstall: false, wiredEvents: ['SessionStart'] }), 'read-only');
  assert.equal(
    defaultHookMode({ freshInstall: false, wiredEvents: ['SessionStart', 'PostToolUseFailure', 'Stop'] }),
    'all',
  );
  // A hand-wired subset matching no preset falls back to the recommended one —
  // there is no preset to re-offer, and the user still picks from the list.
  assert.equal(defaultHookMode({ freshInstall: false, wiredEvents: ['Stop'] }), 'all');
});

test('install --hooks read-only wires only SessionStart', async () => {
  const root = tmp('lk-hooks-ro-');
  const result = await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true, hooks: 'read-only' });
  assert.equal(exitOf(result), 0);

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.SessionStart?.length, 'SessionStart wired');
  assert.equal(settings.hooks.PostToolUseFailure, undefined, 'no failure nudge');
  assert.equal(settings.hooks.Stop, undefined, 'no retrospective nudge');
});

test('install --hooks read-only downgrades an existing all-hooks install', async () => {
  const root = tmp('lk-hooks-downgrade-');
  const base = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  await install(base);
  await install({ ...base, hooks: 'read-only' });

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.SessionStart?.length, 'SessionStart still wired');
  assert.equal(settings.hooks.Stop, undefined, 'Stop pruned, not left firing');
});

test('install --hooks none removes hooks that are already wired', async () => {
  const root = tmp('lk-hooks-none-');
  const base = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  await install(base);
  assert.ok(installedHookEvents(root, 'project').length === 3, 'hooks wired by the first run');

  await install({ ...base, hooks: 'none' });
  assert.deepEqual(installedHookEvents(root, 'project'), [], 'declining removes them');
});

test('install --hooks none preserves co-located third-party hooks', async () => {
  const root = tmp('lk-hooks-none-other-');
  const base = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  await install(base);

  const file = path.join(root, '.claude', 'settings.json');
  const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
  seeded.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo hi' }] });
  fs.writeFileSync(file, JSON.stringify(seeded));

  await install({ ...base, hooks: 'none' });
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cmds = (settings.hooks?.SessionStart ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(cmds, ['echo hi'], 'only lorekit entries removed');
});

test('install --no-hooks is skip-only and leaves already-wired hooks in place', async () => {
  const root = tmp('lk-hooks-skiponly-');
  const base = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  await install(base);

  // --no-hooks has always meant "do not wire", never "take away" — changing
  // that silently would be a breaking change for anyone scripting it.
  await install({ ...base, 'no-hooks': true });
  assert.equal(installedHookEvents(root, 'project').length, 3, 'existing hooks untouched');
});

test('install --hooks with an invalid mode exits non-zero and names the valid modes', async () => {
  const root = tmp('lk-hooks-bogus-');
  const result = await install({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true, hooks: 'sometimes' });
  assert.equal(exitOf(result), 1);
  // Nothing was written — validation happens before any disk work.
  assert.ok(!fs.existsSync(path.join(root, '.mcp.json')), 'no partial install on a bad flag');
});

test('install reports the resolved hooks_mode as a bounded telemetry attribute', async () => {
  const root = tmp('lk-hooks-attr-');
  const base = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };

  const all = await install(base);
  assert.equal(all['lorekit.cli.hooks_mode'], 'all');

  const readOnly = await install({ ...base, hooks: 'read-only' });
  assert.equal(readOnly['lorekit.cli.hooks_mode'], 'read-only');

  // The already-installed short-circuit reports what is wired, not a guess.
  const again = await install(base);
  assert.equal(again['lorekit.cli.hooks_mode'], 'read-only');
});

test('an explicit --hooks reaches the hook step even on a complete install', async () => {
  const root = tmp('lk-hooks-bypass-');
  const base = { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true };
  await install({ ...base, hooks: 'none' });

  // Without the bypass this run would hit the already-installed short-circuit
  // and the user would have to --force a full reinstall to flip one setting.
  await install({ ...base, hooks: 'all' });
  assert.equal(installedHookEvents(root, 'project').length, 3);
});
