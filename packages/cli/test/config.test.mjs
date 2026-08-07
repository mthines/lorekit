// Regression tests for the .mcp.json read paths and copyDir accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readMcpConfig,
  readLorekitServer,
  readJsonIfExists,
  copyDir,
  mcpJsonPath,
  onPath,
  resolveHookRunner,
  writeFileAtomic,
  CLAUDE_HOOK_EVENTS,
  hookEventsForMode,
  hookModeFromEvents,
  installedHookEvents,
  upsertClaudeHooks,
  isMcpJsonGitIgnored,
} from '../src/config.mjs';
import { execFileSync } from 'node:child_process';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-cfg-'));
}

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The committable web .mcp.json (`install --mcp-json`) only reaches a fresh
// Claude-Code-on-the-web clone if it is committed, and .mcp.json is commonly
// git-ignored. `isMcpJsonGitIgnored` is what lets install warn about that.
test('isMcpJsonGitIgnored detects an ignored vs tracked .mcp.json', { skip: !gitAvailable() }, () => {
  // Ignored: a repo whose .gitignore lists .mcp.json.
  const ignored = tmpRoot();
  execFileSync('git', ['-C', ignored, 'init'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(ignored, '.gitignore'), '.mcp.json\n');
  assert.equal(isMcpJsonGitIgnored(ignored), true, 'listed in .gitignore → ignored');

  // Not ignored: a repo with no such rule.
  const tracked = tmpRoot();
  execFileSync('git', ['-C', tracked, 'init'], { stdio: 'ignore' });
  assert.equal(isMcpJsonGitIgnored(tracked), false, 'no rule → not ignored');
});

test('isMcpJsonGitIgnored returns null when the dir is not a git repo', () => {
  // Unknown, not a throw — the caller stays silent rather than warning wrongly.
  assert.equal(isMcpJsonGitIgnored(tmpRoot()), null);
});

// Regression: `npx @lorekit/cli install` stages a `lorekit` symlink into an
// ephemeral …/_npx/<hash>/node_modules/.bin dir and prepends it to PATH. That
// dir must NOT count as a durable install, or hooks get wired as bare
// `lorekit hook …` and fail with `command not found` once npx exits.
test('onPath ignores npx ephemeral bin dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-npx-'));
  const npxBin = path.join(root, '_npx', 'abc123', 'node_modules', '.bin');
  fs.mkdirSync(npxBin, { recursive: true });
  fs.writeFileSync(path.join(npxBin, 'lorekit'), '#!/bin/sh\n');

  const savedPath = process.env.PATH;
  try {
    process.env.PATH = npxBin; // only the ephemeral dir is on PATH
    assert.equal(onPath('lorekit'), false, 'ephemeral npx dir must not count as installed');
    assert.equal(resolveHookRunner(), 'npx -y @lorekit/cli');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('onPath honours a durable global install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-bin-'));
  fs.writeFileSync(path.join(dir, 'lorekit'), '#!/bin/sh\n');

  const savedPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    assert.equal(onPath('lorekit'), true);
    assert.equal(resolveHookRunner(), 'lorekit');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('readMcpConfig distinguishes absent / valid / invalid', () => {
  const root = tmpRoot();
  assert.deepEqual(readMcpConfig(root), { present: false, valid: false, config: null });

  fs.writeFileSync(mcpJsonPath(root), '{ this is not json ');
  const bad = readMcpConfig(root);
  assert.equal(bad.present, true);
  assert.equal(bad.valid, false);

  fs.writeFileSync(mcpJsonPath(root), JSON.stringify({ mcpServers: {} }));
  const ok = readMcpConfig(root);
  assert.equal(ok.valid, true);
  assert.ok(ok.config.mcpServers);
});

test('readLorekitServer never throws on a malformed .mcp.json', () => {
  const root = tmpRoot();
  fs.writeFileSync(mcpJsonPath(root), '{ broken');
  assert.doesNotThrow(() => readLorekitServer(root));
  assert.equal(readLorekitServer(root), null); // degrades to "no server"
});

test('readJsonIfExists still throws on malformed JSON (install clobber-guard)', () => {
  const root = tmpRoot();
  fs.writeFileSync(mcpJsonPath(root), '{ broken');
  assert.throws(() => readJsonIfExists(mcpJsonPath(root)), /Failed to parse/);
});

test('writeFileAtomic replaces content, preserves perms, and leaves no temp file', () => {
  const root = tmpRoot();
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o600); // a locked-down config holding secrets

  writeFileAtomic(file, 'new-content');

  assert.equal(fs.readFileSync(file, 'utf8'), 'new-content', 'content replaced');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'original 0600 perms preserved on replace');
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => f.includes('.tmp')),
    [],
    'no leftover temp file',
  );
});

test('writeFileAtomic creates a new file (and its parent dir) when absent', () => {
  const root = tmpRoot();
  const file = path.join(root, 'nested', 'dir', '.mcp.json');
  writeFileAtomic(file, 'fresh');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh');
});

test('copyDir reports how many files it actually wrote', () => {
  const src = tmpRoot();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'b');
  const dest = path.join(tmpRoot(), 'out');

  assert.equal(copyDir(src, dest), 2); // fresh install: both files written
  assert.equal(copyDir(src, dest), 0); // re-run without --force: nothing written
  assert.equal(copyDir(src, dest, { force: true }), 2); // force: both rewritten
});

// ── mcp.endpoint in .lorekit.json ─────────────────────────────────────────────
import { resolveProjectConnection } from '../src/config.mjs';
import { splitEndpoint } from '../src/mcp.mjs';

test('resolveProjectConnection uses mcp.endpoint from .lorekit.json as fallback', () => {
  const root = tmpRoot();
  const ep = 'https://abc.supabase.co/functions/v1/mcp';
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'mcp.endpoint': ep }));
  const conn = resolveProjectConnection(root, splitEndpoint);
  assert.equal(conn.endpoint, ep);
});

test('resolveProjectConnection prefers .mcp.json over mcp.endpoint in .lorekit.json', () => {
  const root = tmpRoot();
  const mpcEp = 'https://primary.supabase.co/functions/v1/mcp';
  const fallbackEp = 'https://fallback.supabase.co/functions/v1/mcp';
  const mcpJson = {
    mcpServers: {
      lorekit: {
        command: 'npx',
        args: ['-y', 'mcp-remote', mpcEp, '--header', 'Authorization:Bearer lk_rw_tok'],
      },
    },
  };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(mcpJson));
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'mcp.endpoint': fallbackEp }));
  const conn = resolveProjectConnection(root, splitEndpoint);
  assert.equal(conn.endpoint, mpcEp);
});

test('resolveProjectConnection ignores placeholder mcp.endpoint', () => {
  const root = tmpRoot();
  fs.writeFileSync(
    path.join(root, '.lorekit.json'),
    JSON.stringify({ 'mcp.endpoint': 'https://<project-ref>.supabase.co/functions/v1/mcp' }),
  );
  const conn = resolveProjectConnection(root, splitEndpoint);
  assert.equal(conn.endpoint, null);
});

// ── Hook modes: the vocabulary `install` and `doctor` share ──────────────────

test('hookEventsForMode maps each preset to its event set', () => {
  assert.deepEqual(hookEventsForMode('all'), CLAUDE_HOOK_EVENTS);
  assert.deepEqual(hookEventsForMode('read-only'), ['SessionStart']);
  assert.deepEqual(hookEventsForMode('none'), []);
  // An unknown mode must never silently disable the hooks — it falls back to
  // the full set, and `install` refuses the flag before it ever gets here.
  assert.deepEqual(hookEventsForMode('nonsense'), CLAUDE_HOOK_EVENTS);
});

test('hookModeFromEvents is the inverse, and reports an unrecognised set as custom', () => {
  assert.equal(hookModeFromEvents(CLAUDE_HOOK_EVENTS), 'all');
  assert.equal(hookModeFromEvents(['SessionStart']), 'read-only');
  assert.equal(hookModeFromEvents([]), 'none');
  assert.equal(hookModeFromEvents(undefined), 'none');
  assert.equal(hookModeFromEvents(['Stop']), 'custom');
  assert.equal(hookModeFromEvents(['SessionStart', 'Stop']), 'custom');
  // Order must not matter — the settings file is not ordered.
  assert.equal(hookModeFromEvents([...CLAUDE_HOOK_EVENTS].reverse()), 'all');
});

test('installedHookEvents reads only lorekit entries, and never throws', () => {
  const root = tmpRoot();
  assert.deepEqual(installedHookEvents(root, 'project'), [], 'absent settings file → none');

  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const settings = path.join(root, '.claude', 'settings.json');

  fs.writeFileSync(settings, '{ not json');
  assert.deepEqual(installedHookEvents(root, 'project'), [], 'corrupt settings → none, no throw');

  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'npx -y @lorekit/cli hook --event SessionStart' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo not-ours' }] }],
      },
    }),
  );
  assert.deepEqual(installedHookEvents(root, 'project'), ['SessionStart'], 'third-party hooks ignored');
});

test('upsertClaudeHooks prunes lorekit entries for events outside the selected set', () => {
  const root = tmpRoot();
  upsertClaudeHooks(root, 'project', 'lorekit');
  assert.deepEqual(installedHookEvents(root, 'project'), CLAUDE_HOOK_EVENTS);

  // Downgrading must REMOVE, not just stop adding — otherwise the nudges keep
  // firing after the user asked for read-only.
  const result = upsertClaudeHooks(root, 'project', 'lorekit', hookEventsForMode('read-only'));
  assert.equal(result.removed, 2);
  assert.deepEqual(installedHookEvents(root, 'project'), ['SessionStart']);
});

// ── Duplicate lorekit hook entries: reconcile, never accumulate ──────────────
//
// `install` (and `install --force`) is the ONE command a user runs to repair a
// broken wiring, so it must converge on exactly one lorekit entry per event.
// Two ways a settings.json grows a second one in the field: the marketplace
// plugin wiring `npx -y @lorekit/cli hook …` on top of a CLI install that wired
// bare `lorekit hook …`, and a runner form the matcher failed to recognise as
// ours (a pinned `@lorekit/cli@1.2.3`, a Windows `lorekit.cmd`) — which used to
// be APPENDED alongside instead of updated in place.

// Every lorekit-looking hook command wired for one event, flattened.
function lorekitCommandsFor(root, event) {
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const groups = (settings.hooks && settings.hooks[event]) || [];
  return groups
    .flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : []))
    .map((h) => h && h.command)
    .filter((cmd) => typeof cmd === 'string' && /lorekit/.test(cmd));
}

function seedSettings(root, hooks) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2));
  return root;
}

test('upsertClaudeHooks collapses pre-existing duplicate lorekit entries (separate groups)', () => {
  const root = seedSettings(tmpRoot(), {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'npx -y @lorekit/cli hook --adapter claude --event SessionStart --dir "${CLAUDE_PROJECT_DIR}"' }] },
      { hooks: [{ type: 'command', command: 'lorekit hook --adapter claude --event SessionStart' }] },
    ],
  });

  const result = upsertClaudeHooks(root, 'project', 'lorekit');
  assert.equal(result.deduped, 1, 'the second lorekit entry is reported as de-duplicated');
  assert.deepEqual(lorekitCommandsFor(root, 'SessionStart'), [
    'lorekit hook --adapter claude --event SessionStart --dir "${CLAUDE_PROJECT_DIR}"',
  ]);
});

test('upsertClaudeHooks collapses duplicates inside one group and keeps co-located third-party hooks', () => {
  const root = seedSettings(tmpRoot(), {
    Stop: [
      {
        hooks: [
          { type: 'command', command: 'lorekit hook --adapter claude --event Stop --dir "${CLAUDE_PROJECT_DIR}"' },
          { type: 'command', command: 'npx -y @lorekit/cli hook --adapter claude --event Stop --dir "${CLAUDE_PROJECT_DIR}"' },
          { type: 'command', command: 'echo not-ours' },
        ],
      },
    ],
  });

  const result = upsertClaudeHooks(root, 'project', 'lorekit');
  assert.equal(result.deduped, 1);
  assert.deepEqual(lorekitCommandsFor(root, 'Stop'), [
    'lorekit hook --adapter claude --event Stop --dir "${CLAUDE_PROJECT_DIR}"',
  ]);
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(stopCommands.includes('echo not-ours'), 'a third-party hook on the same event survives');
});

test('upsertClaudeHooks is idempotent over a duplicated settings file', () => {
  const root = seedSettings(tmpRoot(), {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'lorekit hook --adapter claude --event SessionStart' }] },
      { hooks: [{ type: 'command', command: 'lorekit hook --adapter claude --event SessionStart' }] },
    ],
  });

  upsertClaudeHooks(root, 'project', 'lorekit');
  const second = upsertClaudeHooks(root, 'project', 'lorekit');
  assert.equal(second.deduped, 0, 'nothing left to de-duplicate on the second run');
  assert.equal(second.added, 0);
  assert.equal(lorekitCommandsFor(root, 'SessionStart').length, 1);
});

test('a version-pinned or extension-suffixed runner is recognised as ours, not appended alongside', () => {
  const root = seedSettings(tmpRoot(), {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'npx -y @lorekit/cli@1.2.3 hook --adapter claude --event SessionStart' }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: 'C:\\Users\\me\\bin\\lorekit.cmd hook --adapter claude --event Stop' }] },
    ],
  });

  const result = upsertClaudeHooks(root, 'project', 'lorekit');
  assert.equal(result.added, 1, 'only PostToolUseFailure is genuinely new');
  assert.equal(lorekitCommandsFor(root, 'SessionStart').length, 1, 'pinned runner updated in place');
  assert.equal(lorekitCommandsFor(root, 'Stop').length, 1, 'windows runner updated in place');
});

test('the lorekit hook matcher does not claim an unrelated command that merely ends in "lorekit"', () => {
  const root = seedSettings(tmpRoot(), {
    Stop: [{ hooks: [{ type: 'command', command: 'mylorekit hook --event Stop' }] }],
  });

  upsertClaudeHooks(root, 'project', 'lorekit');
  const commands = lorekitCommandsFor(root, 'Stop');
  assert.ok(commands.includes('mylorekit hook --event Stop'), 'the third-party command is left alone');
  assert.ok(
    commands.includes('lorekit hook --adapter claude --event Stop --dir "${CLAUDE_PROJECT_DIR}"'),
    'our own entry is still wired',
  );
});
