// Project layout + .mcp.json read/merge helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/ — the installable package root (this file lives in src/).
export const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SKILL_SOURCE = path.join(PKG_ROOT, 'skill', 'lorekit-memory');
export const SKILL_NAME = 'lorekit-memory';

export function resolveProjectRoot(dir) {
  return path.resolve(dir || process.cwd());
}

// Atomic config write: serialize to a sibling temp file, then rename over the
// target. rename(2) is atomic within a filesystem, so a crash / Ctrl-C / ENOSPC
// mid-write can never leave a half-written (corrupt) file — the original stays
// intact until the complete new content is swapped in. This matters most for
// ~/.claude.json, which can be large and holds all of Claude Code's per-project
// state and OAuth tokens. The temp file inherits the target's permissions when
// it exists (so we don't widen a locked-down 0600 config to 0644 on replace).
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    try {
      fs.chmodSync(tmp, fs.statSync(file).mode);
    } catch {
      /* target didn't exist — leave the temp file's default perms */
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup of the temp file */
    }
    throw e;
  }
}

// The user's home directory. Honors $HOME / %USERPROFILE% (so it can be
// redirected in tests) and falls back to the OS lookup.
export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function mcpJsonPath(root) {
  return path.join(root, '.mcp.json');
}

// Where the MCP server entry is written for a given scope:
//   project → <root>/.mcp.json          (Claude Code project config)
//   global  → ~/.claude.json            (Claude Code user config, all projects)
export function mcpConfigPath(root, scope = 'project') {
  return scope === 'global' ? path.join(homeDir(), '.claude.json') : mcpJsonPath(root);
}

// Where the skill is scaffolded for a given scope:
//   project → <root>/.claude/skills/…   (this repo only)
//   global  → ~/.claude/skills/…        (personal skills, all projects)
export function skillInstallDir(root, scope = 'project') {
  const base = scope === 'global' ? homeDir() : root;
  return path.join(base, '.claude', 'skills', SKILL_NAME);
}

// Claude Code settings file that holds the hooks for a given scope:
//   project → <root>/.claude/settings.json
//   global  → ~/.claude/settings.json
export function settingsPath(root, scope = 'project') {
  const base = scope === 'global' ? homeDir() : root;
  return path.join(base, '.claude', 'settings.json');
}

// The lifecycle events the memory loop wires: read lessons on start, nudge on a
// tool failure, nudge a retrospective at end of turn. Mirrors the plugin's
// hooks.json so `install` delivers the same deterministic layer.
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'PostToolUseFailure', 'Stop'];

// Matches a hook command that fires the lorekit engine, whether wired as a
// global `lorekit hook …` or `npx -y @lorekit/cli hook …`. Shared by the
// upsert (find-or-update) and remove (uninstall) paths so they agree on what
// counts as "ours".
export const LOREKIT_HOOK_RE = /(?:@lorekit\/cli|lorekit) hook\b/;

// npx stages the package's own bin into an ephemeral cache dir
// (…/_npx/<hash>/node_modules/.bin) and prepends it to PATH for the lifetime of
// the `npx @lorekit/cli …` process. That makes `lorekit` *look* globally
// installed during `install`, so the hooks get wired as bare `lorekit hook …`
// — but the symlink vanishes when npx exits, and Claude Code then fails every
// hook with `lorekit: command not found`. Excluding these transient dirs keeps
// the bare-`lorekit` runner reserved for a genuine global install.
const isEphemeralNpxDir = (dir) => /[\\/]_npx[\\/]/.test(dir);

// Is `bin` resolvable on a *durable* PATH entry? Used to prefer a fast global
// `lorekit` over `npx` for hook commands. Zero-dep, cross-platform.
export function onPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (!dir || isEphemeralNpxDir(dir)) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, bin + ext))) return true;
      } catch {
        /* ignore unreadable PATH entries */
      }
    }
  }
  return false;
}

// The command prefix for hook entries: a global `lorekit` when it's installed
// (fast — no npx resolution per event), else `npx -y @lorekit/cli`.
export function resolveHookRunner() {
  return onPath('lorekit') ? 'lorekit' : 'npx -y @lorekit/cli';
}

// Read the lorekit MCP server entry out of an arbitrary config file.
function readServerFromFile(file) {
  if (!fs.existsSync(file)) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const server = config && config.mcpServers && config.mcpServers.lorekit;
  if (!server) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const url = args.find((a) => typeof a === 'string' && /^https?:\/\//.test(a));
  return { server, url: url || null };
}

// Wire the lorekit hook engine into Claude Code settings for the scope,
// preserving all other settings and any non-lorekit hooks. Idempotent: an
// existing lorekit hook entry per event is updated in place, never duplicated.
// `runner` is the command prefix (e.g. 'lorekit' or 'npx -y @lorekit/cli').
export function upsertClaudeHooks(root, scope, runner) {
  const file = settingsPath(root, scope);
  const config = readJsonIfExists(file) || {};
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const event of CLAUDE_HOOK_EVENTS) {
    const command = `${runner} hook --adapter claude --event ${event} --dir "\${CLAUDE_PROJECT_DIR}"`;
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    const groups = config.hooks[event];

    let existing = null;
    for (const group of groups) {
      const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
      existing = inner.find(
        (h) => h && typeof h.command === 'string' && LOREKIT_HOOK_RE.test(h.command),
      );
      if (existing) break;
    }

    if (existing) {
      if (existing.command === command) unchanged++;
      else {
        existing.command = command;
        updated++;
      }
    } else {
      groups.push({ hooks: [{ type: 'command', command }] });
      added++;
    }
  }

  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return { file, added, updated, unchanged };
}

// Throwing read — used by `install` so a corrupt .mcp.json aborts the write
// instead of silently clobbering the user's file.
export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e.message}`);
  }
}

// Non-throwing read — used by the diagnostic (doctor) and hook read paths,
// which must degrade gracefully rather than crash on a malformed file.
// Distinguishes absent from present-but-invalid so callers can report it.
export function readMcpConfig(root) {
  const file = mcpJsonPath(root);
  if (!fs.existsSync(file)) return { present: false, valid: false, config: null };
  try {
    return { present: true, valid: true, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { present: true, valid: false, config: null };
  }
}

// Merge a lorekit server entry into the scope's MCP config, preserving any
// other servers (and, for the global ~/.claude.json, all other user settings).
export function upsertMcpServer(root, remoteUrl, scope = 'project') {
  const file = mcpConfigPath(root, scope);
  const config = readJsonIfExists(file) || {};
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const existed = Boolean(config.mcpServers.lorekit);
  config.mcpServers.lorekit = {
    command: 'npx',
    args: ['-y', 'mcp-remote', remoteUrl],
  };
  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return { file, existed };
}

// Pull the configured lorekit remote URL out of the project .mcp.json, if
// present. Non-throwing: returns null when the file is absent, invalid, or has
// no lorekit server. Callers that need to distinguish those use readMcpConfig.
export function readLorekitServer(root) {
  return readServerFromFile(mcpJsonPath(root));
}

// --- uninstall: surgical removal of the three things `install` writes. -------
// Each helper touches only lorekit's own entries and leaves every other
// server / hook / setting intact, so uninstalling never damages a shared
// ~/.claude.json or settings.json.

// Delete the scaffolded skill directory. We own the whole
// .claude/skills/lorekit-memory tree, so a recursive remove is safe.
export function removeSkill(root, scope = 'project') {
  const dest = skillInstallDir(root, scope);
  const removed = fs.existsSync(dest);
  if (removed) fs.rmSync(dest, { recursive: true, force: true });
  return { dest, removed };
}

// Drop the `lorekit` MCP server entry, preserving any other servers (and, for
// the global ~/.claude.json, all other user settings). Prunes an emptied
// mcpServers object. No-op (no write) when there's nothing to remove.
export function removeMcpServer(root, scope = 'project') {
  const file = mcpConfigPath(root, scope);
  const config = readJsonIfExists(file);
  const hasEntry =
    config &&
    config.mcpServers &&
    typeof config.mcpServers === 'object' &&
    Object.prototype.hasOwnProperty.call(config.mcpServers, 'lorekit');
  if (!hasEntry) return { file, removed: false };

  delete config.mcpServers.lorekit;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return { file, removed: true };
}

// Strip lorekit hook entries from every event, preserving non-lorekit hooks in
// the same groups. Prunes groups left with no hooks and events left with no
// groups. Returns the count removed; only writes when something changed.
export function removeClaudeHooks(root, scope = 'project') {
  const file = settingsPath(root, scope);
  const config = readJsonIfExists(file);
  if (!config || !config.hooks || typeof config.hooks !== 'object') {
    return { file, removed: 0 };
  }

  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const groups = config.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(
        (h) => !(h && typeof h.command === 'string' && LOREKIT_HOOK_RE.test(h.command)),
      );
      removed += before - group.hooks.length;
    }
    config.hooks[event] = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  if (removed > 0) writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return { file, removed };
}

// Recursively copy the skill source into the target, skipping files that
// already exist unless `force` is set. Returns the number of files actually
// written, so the caller can report "installed" / "updated" / "unchanged"
// honestly instead of guessing from whether the directory pre-existed.
export function copyDir(src, dest, { force = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  let written = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      written += copyDir(from, to, { force });
    } else {
      if (fs.existsSync(to) && !force) continue;
      fs.copyFileSync(from, to);
      written++;
    }
  }
  return written;
}

// Resolve endpoint + token from flags, then env, in that order.
export function resolveConnection(args) {
  const endpoint =
    args.endpoint ||
    process.env.LOREKIT_MCP_URL ||
    process.env.LOREKIT_ENDPOINT ||
    null;
  const token = args.token || process.env.LOREKIT_TOKEN || null;
  return {
    endpoint: typeof endpoint === 'string' ? endpoint.trim() : null,
    token: typeof token === 'string' ? token.trim() : null,
  };
}

export function tokenKind(token) {
  if (!token) return 'none';
  if (token.startsWith('lk_rw_')) return 'read-write';
  if (token.startsWith('lk_ro_')) return 'read-only';
  if (token.startsWith('lk_wo_')) return 'write-only';
  return 'unknown';
}

// For hooks: resolve the connection closest-scope first — the project's
// .mcp.json (a project install), then the global ~/.claude.json (a global
// install), then env. `splitEndpoint` is passed in to avoid a circular import
// with mcp.mjs.
export function resolveProjectConnection(root, splitEndpoint) {
  const sources = [readLorekitServer(root), readServerFromFile(mcpConfigPath(root, 'global'))];
  for (const configured of sources) {
    if (configured && configured.url) {
      const { endpoint, token } = splitEndpoint(configured.url);
      if (endpoint && !endpoint.includes('<project-ref>')) {
        return {
          endpoint,
          token: token || process.env.LOREKIT_TOKEN || null,
        };
      }
    }
  }
  return resolveConnection({});
}
