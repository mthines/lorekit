// Project layout + .mcp.json read/merge helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// packages/cli/ — the installable package root (this file lives in src/shared/).
export const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SKILL_NAME = 'lorekit-memory';
export const SKILL_SOURCE = path.join(PKG_ROOT, 'skill', SKILL_NAME);

// Every skill the CLI ships. `lorekit-memory` is the operational read/write
// loop (kept first as the primary — `SKILL_NAME`/`SKILL_SOURCE` above alias it
// for back-compat); `lorekit-setup` is the authoring skill that wires a
// self-improvement loop into a host; `lorekit-groom` is the maintenance skill
// that dedupes/lints/merges/expires an accumulated store. install/uninstall/
// doctor iterate this list.
export const SKILLS = ['lorekit-memory', 'lorekit-setup', 'lorekit-groom'].map((name) => ({
  name,
  source: path.join(PKG_ROOT, 'skill', name),
}));

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
export function skillInstallDir(root, scope = 'project', name = SKILL_NAME) {
  const base = scope === 'global' ? homeDir() : root;
  return path.join(base, '.claude', 'skills', name);
}

// Claude Code settings file that holds the hooks for a given scope:
//   project → <root>/.claude/settings.json
//   global  → ~/.claude/settings.json
export function settingsPath(root, scope = 'project') {
  const base = scope === 'global' ? homeDir() : root;
  return path.join(base, '.claude', 'settings.json');
}

// The lifecycle events the memory loop wires: read lessons on start, pull the
// ones matching each substantive prompt as the turn is submitted, nudge on a
// tool failure, nudge a retrospective at end of turn. Mirrors the plugin's
// hooks.json so `install` delivers the same deterministic layer — a parity test
// in `test/frameworks.test.mjs` holds the two lists to that claim.
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUseFailure', 'Stop'];

// The event set `all` meant BEFORE `UserPromptSubmit` was wired.
//
// It exists for one job: `hookModeFromEvents` must still answer 'all' for an
// install done before that event existed. Without this, every pre-existing
// installation would read as 'custom' the next time `install` inspected it —
// and 'custom' is the answer that means "a human hand-wired this, do not touch
// it", so the upgrade prompt would default to leaving them behind on the old
// three events forever. Recognising the legacy set is what lets `install`
// UPGRADE such a wiring instead of preserving it verbatim.
//
// It does NOT make a bare `install` re-run an upgrade. A fully-installed scope
// short-circuits in `install.mjs` before the hook step, so reaching this
// recognition still needs `--hooks <mode>` or `--force`; the short-circuit
// summary names that command when an upgrade is available.
//
// Add to this list, never edit it: each entry is a historical fact about a
// version that shipped, not a configuration.
const LEGACY_ALL_EVENT_SETS = [
  ['SessionStart', 'PostToolUseFailure', 'Stop'],
];

// Matches a hook command that fires the lorekit engine, whether wired as a
// global `lorekit hook …` or `npx -y @lorekit/cli hook …`. Shared by the
// upsert (find-or-update) and remove (uninstall) paths so they agree on what
// counts as "ours" — a form this misses is not merely un-updated, it is
// APPENDED alongside on the next install, which is how a settings.json ends up
// firing the same hook twice.
//
// The three deliberate tolerances, each a real wiring seen in the wild:
//   • a leading path or quote — `/usr/local/bin/lorekit hook`, `"…/lorekit" hook`
//   • a pinned version        — `npx -y @lorekit/cli@1.2.3 hook`
//   • a platform extension    — `lorekit.cmd hook` on Windows
// The leading boundary is REQUIRED (start of string, whitespace, a path
// separator or a quote) so an unrelated `mylorekit hook …` is somebody else's
// command and stays untouched — the previous pattern claimed it.
export const LOREKIT_HOOK_RE =
  /(?:^|[\s"'`(=/\\])(?:@lorekit\/cli|lorekit)(?:@[^\s"']+)?(?:\.(?:cmd|exe|bat|ps1|mjs|js))?\s+hook\b/;

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

// The hook wiring presets `install` offers. They are presets over
// CLAUDE_HOOK_EVENTS, NOT a per-event checkbox list — the meaningful decision a
// user makes is "read my lessons / also nudge me / neither", and `hooks.disabled`
// already exists for surgical per-event suppression after the fact.
//   all       — every lifecycle event (the recommended default)
//   read-only — SessionStart only: lessons are injected, nothing ever nudges
//   none      — no hooks; the skills stay model-invoked only
export const HOOK_MODES = ['all', 'read-only', 'none'];

// Pure: the events a mode wires. An unknown mode yields the full set, so a
// mis-typed value can never silently disable the hooks — `install` validates the
// flag up front and refuses instead.
export function hookEventsForMode(mode) {
  if (mode === 'none') return [];
  if (mode === 'read-only') return ['SessionStart'];
  return [...CLAUDE_HOOK_EVENTS];
}

// Pure inverse of `hookEventsForMode`: which mode does this set of wired events
// correspond to? `custom` for anything that matches no preset (e.g. someone hand-
// wired only `Stop`) — the caller must not silently rewrite such a setup.
export function hookModeFromEvents(events) {
  const set = new Set(events || []);
  const matches = (want) => want.length === set.size && want.every((e) => set.has(e));
  for (const mode of HOOK_MODES) {
    if (matches(hookEventsForMode(mode))) return mode;
  }
  // An install from before a lifecycle event was added is still 'all' — see
  // LEGACY_ALL_EVENT_SETS for why reading it as 'custom' would strand it.
  for (const legacy of LEGACY_ALL_EVENT_SETS) {
    if (matches(legacy)) return 'all';
  }
  return 'custom';
}

// Which events an existing wiring is MISSING relative to the mode it reads as.
//
// An install predating a lifecycle event still reads as its mode (see
// LEGACY_ALL_EVENT_SETS), so `hookModeFromEvents` alone cannot tell a current
// `all` from a stale one — and a stale one keeps reporting the mode it no
// longer delivers. This is the difference, and it is the single derivation
// BOTH surfaces that report it use: `install`'s already-installed summary and
// `doctor`'s hooks line. A second copy is how the two would come to disagree
// about what "up to date" means.
//
// `custom` yields [] deliberately: it means a human hand-wired this, and
// `hookEventsForMode` answers the full set for any unrecognised mode, so
// anything else would advertise an "upgrade" away from a wiring the user chose.
export function missingHookEvents(events) {
  const mode = hookModeFromEvents(events);
  if (mode === 'custom') return [];
  const wired = new Set(events || []);
  return hookEventsForMode(mode).filter((e) => !wired.has(e));
}

// Extract the flat list of hook command strings for one event out of the nested
// group shape Claude Code uses: { [event]: [ { hooks: [ { type, command } ] } ] }.
export function hookCommandsForEvent(hooksObj, event) {
  const groups = hooksObj && Array.isArray(hooksObj[event]) ? hooksObj[event] : [];
  const commands = [];
  for (const group of groups) {
    const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
    for (const h of inner) {
      if (h && typeof h.command === 'string') commands.push(h.command);
    }
  }
  return commands;
}

// Which CLAUDE_HOOK_EVENTS currently have a lorekit hook wired in this scope's
// settings file. Best-effort: an absent or unparseable file reads as none — this
// is a detection helper (it decides a prompt default and a doctor line), never a
// write path, so it must not throw. The single reader shared by `install` and
// `doctor` so the two can never disagree about what is wired.
export function installedHookEvents(root, scope = 'project') {
  let hooks = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath(root, scope), 'utf8'));
    if (cfg && typeof cfg.hooks === 'object' && cfg.hooks) hooks = cfg.hooks;
  } catch {
    return [];
  }
  return CLAUDE_HOOK_EVENTS.filter((event) =>
    hookCommandsForEvent(hooks, event).some((cmd) => LOREKIT_HOOK_RE.test(cmd)),
  );
}

// Wire the lorekit hook engine into Claude Code settings for the scope,
// preserving all other settings and any non-lorekit hooks. Idempotent: an
// existing lorekit hook entry per event is updated in place, never duplicated.
// `runner` is the command prefix (e.g. 'lorekit' or 'npx -y @lorekit/cli').
//
// CONVERGENT, not merely additive: an event carrying SEVERAL lorekit entries
// keeps exactly ONE — the first is updated in place and every further one is
// deleted (counted as `deduped`). Reconciling only the first left the extras
// firing forever, and `install --force` — the one command a user reaches for
// precisely because the wiring is wrong — could not repair the very state it is
// most often run against. Duplicates arrive from outside this function (the
// marketplace plugin wiring `npx -y @lorekit/cli hook …` over a CLI-wired bare
// `lorekit hook …`, a merged settings.json, a hand edit), so recognising them
// on write is the only place the invariant can hold.
//
// `events` selects WHICH of CLAUDE_HOOK_EVENTS to wire (default: all of them).
// Any lorekit entry for a CLAUDE_HOOK_EVENT *not* in the list is REMOVED — that
// pruning is what makes a downgrade (all → read-only) an actual downgrade rather
// than an additive no-op that leaves the nudges firing. Only lorekit's own
// entries are touched; a co-located third-party hook on the same event survives.
export function upsertClaudeHooks(root, scope, runner, events = CLAUDE_HOOK_EVENTS) {
  const file = settingsPath(root, scope);
  const config = readJsonIfExists(file) || {};
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};

  const wanted = new Set(events);
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  let deduped = 0;

  for (const event of CLAUDE_HOOK_EVENTS) {
    if (!wanted.has(event)) {
      removed += pruneLorekitHooks(config.hooks, event);
      continue;
    }
    const command = `${runner} hook --adapter claude --event ${event} --dir "\${CLAUDE_PROJECT_DIR}"`;
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    const groups = config.hooks[event];

    // EVERY lorekit entry for this event, in document order — not just the
    // first, which is what made a duplicated file un-repairable.
    const matches = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook && typeof hook.command === 'string' && LOREKIT_HOOK_RE.test(hook.command)) {
          matches.push({ group, hook });
        }
      }
    }

    const [canonical, ...extras] = matches;
    if (canonical) {
      if (canonical.hook.command === command) unchanged++;
      else {
        canonical.hook.command = command;
        updated++;
      }
    } else {
      groups.push({ hooks: [{ type: 'command', command }] });
      added++;
    }

    // Drop the surplus copies, then tidy only the groups this emptied — a group
    // that arrived empty is somebody else's business, and a group still holding
    // a third-party hook must survive.
    const emptied = new Set();
    for (const extra of extras) {
      extra.group.hooks = extra.group.hooks.filter((h) => h !== extra.hook);
      deduped++;
      if (extra.group.hooks.length === 0) emptied.add(extra.group);
    }
    if (emptied.size > 0) {
      config.hooks[event] = groups.filter((g) => !emptied.has(g));
    }
  }

  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return { file, added, updated, unchanged, removed, deduped };
}

// Drop every lorekit hook entry for one event from a hooks object, tidying up
// the groups and the event key it empties. Returns how many entries went. Shared
// by `upsertClaudeHooks`'s pruning and `removeClaudeHooks`'s full teardown.
function pruneLorekitHooks(hooksObj, event) {
  const groups = hooksObj[event];
  if (!Array.isArray(groups)) return 0;

  let removed = 0;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(
      (h) => !(h && typeof h.command === 'string' && LOREKIT_HOOK_RE.test(h.command)),
    );
    removed += before - group.hooks.length;
  }
  hooksObj[event] = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
  if (hooksObj[event].length === 0) delete hooksObj[event];
  return removed;
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

// The environment variable the committable (web) .mcp.json references for its
// token, instead of embedding a live secret. Kept as a constant so the writer,
// the install summary, and the docs can never name a different variable.
export const WEB_TOKEN_ENV_VAR = 'LOREKIT_TOKEN';

// Strip any credential from an endpoint URL before it goes into the committable
// web .mcp.json. The whole point of that file is to carry NO secret, so an
// `--endpoint` / LOREKIT_MCP_URL value that already embeds `?token=lk_…` (a
// perfectly ordinary thing to paste) must not be written verbatim — that would
// commit a live token in the file install tells you to commit. Mirrors
// `splitEndpoint`'s token removal (mcp.mjs) inline rather than importing it, so
// config.mjs keeps its no-mcp.mjs-import invariant (see resolveProjectConnection),
// and also clears userinfo for defense in depth. A non-URL string is left as-is;
// endpoint validity is the caller's concern, not this function's.
function stripEndpointCredentials(endpoint) {
  try {
    const u = new URL(endpoint);
    u.searchParams.delete('token');
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return endpoint;
  }
}

// Merge a lorekit server entry into the PROJECT-root .mcp.json in the
// committable form Claude Code on the web needs: instead of embedding the token
// in the URL (a live secret, which is why the embedded form is git-ignored), it
// authenticates via an mcp-remote `--header` that references `${LOREKIT_TOKEN}`.
//
// WHY this exists as a distinct writer. Claude Code on the web clones the repo
// fresh into an ephemeral container, so the only MCP config it can see is a
// COMMITTED, repo-root `.mcp.json` — a global `~/.claude.json` never travels to
// the clone. And it must be committable, which the embedded-token form is not.
// So the web path needs exactly this: the project file (never the global one)
// with the token supplied at runtime from an environment secret. Callers set
// `LOREKIT_TOKEN` as an environment secret in the web UI; the value is expanded
// by Claude Code before mcp-remote is spawned. Preserves any other servers.
//
// The endpoint is credential-stripped first: it is the one field that could
// carry a `?token=` in from `--endpoint` / LOREKIT_MCP_URL, and writing that
// into a file meant to be committed would leak a live token.
export function upsertWebMcpServer(root, endpoint, envVar = WEB_TOKEN_ENV_VAR) {
  const file = mcpJsonPath(root); // always the project file — the web clone only sees this one
  const config = readJsonIfExists(file) || {};
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const existed = Boolean(config.mcpServers.lorekit);
  config.mcpServers.lorekit = {
    command: 'npx',
    args: ['-y', 'mcp-remote', stripEndpointCredentials(endpoint), '--header', `Authorization:Bearer \${${envVar}}`],
  };
  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return { file, existed };
}

// Is the project .mcp.json git-ignored in this repo? Tri-state so callers can
// distinguish "definitely ignored" from "can't tell" and stay quiet when unsure:
//   true  → ignored (git check-ignore matched)  — the caller warns
//   false → tracked / not ignored               — nothing to say
//   null  → unknown (no git, not a repo, error)  — say nothing
//
// This exists because the committable web .mcp.json (upsertWebMcpServer) only
// works if it is actually committed, and .mcp.json is COMMONLY git-ignored (the
// default embedded-token form is a secret, so LoreKit's own root .gitignore and
// many projects ignore it). Silently writing a file the repo will never commit
// is the trap this lets `install --mcp-json` warn about. `git check-ignore -q`
// exits 0 when ignored, 1 when not, 128 on error — anything but 0/1 is unknown.
export function isMcpJsonGitIgnored(root) {
  try {
    const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '.mcp.json'], { stdio: 'ignore' });
    if (r.error) return null; // git not found / spawn failed
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null; // 128 (not a repo) or anything unexpected
  } catch {
    return null;
  }
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

// Delete a scaffolded skill directory. We own the whole
// .claude/skills/<name> tree for each skill we ship, so a recursive remove is safe.
export function removeSkill(root, scope = 'project', name = SKILL_NAME) {
  const dest = skillInstallDir(root, scope, name);
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

// Is a lorekit server entry the committable WEB form — auth via a `--header`
// that references an `${ENV_VAR}` token, as written by `upsertWebMcpServer` —
// rather than an embedded-token or plain URL entry? Used to gate the global
// uninstall's project-file cleanup so it only removes what `--mcp-json` wrote.
export function isWebMcpServerEntry(server) {
  const args = server && Array.isArray(server.args) ? server.args : [];
  const i = args.indexOf('--header');
  if (i === -1 || typeof args[i + 1] !== 'string') return false;
  return /^Authorization:Bearer \$\{[^}]+\}$/.test(args[i + 1].trim());
}

// Remove the lorekit entry from the PROJECT .mcp.json ONLY when it is the
// committable web form. `uninstall --global` calls this to clean up the file
// `install --global --mcp-json` wrote — WITHOUT touching an unrelated
// embedded-token `install --project` entry a user set up separately (which a
// blind removeMcpServer(root, 'project') would delete). No-op otherwise.
export function removeWebMcpServer(root) {
  const file = mcpJsonPath(root);
  const config = readJsonIfExists(file);
  const server =
    config && config.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers.lorekit
      : null;
  if (!server || !isWebMcpServerEntry(server)) return { file, removed: false };

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
  // Snapshot the keys: pruneLorekitHooks deletes the ones it empties.
  for (const event of Object.keys(config.hooks)) {
    removed += pruneLorekitHooks(config.hooks, event);
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
// install), then the `mcp.endpoint` field in .lorekit.json (committable URL
// without token — safe for VCS), then env. `splitEndpoint` is passed in to
// avoid a circular import with mcp.mjs.
//
// A source that STORES a token wins outright (project beats global — closest
// scope), and it brings its OWN endpoint: a token authenticates one endpoint,
// so the two must travel together. A TOKENLESS source therefore never shadows a
// later source that has a token — not its token AND not its endpoint; its
// endpoint is only remembered as a fallback, used solely when NO source stores a
// token. (So "closest-scope-first" governs which token wins; the endpoint simply
// follows that token.)
// That shadowing is exactly what `install --global --mcp-json` created: it
// writes a committable, token-free project .mcp.json (auth via ${LOREKIT_TOKEN})
// AND the real token into ~/.claude.json. Returning early on the project entry
// left the local CLI, doctor, and hooks resolving `token: null` unless
// LOREKIT_TOKEN was exported — so a tokenless source is only remembered as an
// endpoint fallback, and the loop keeps looking for a stored token.
export function resolveProjectConnection(root, splitEndpoint) {
  const sources = [readLorekitServer(root), readServerFromFile(mcpConfigPath(root, 'global'))];
  let endpointOnly = null; // closest usable endpoint that carried no token (e.g. the web .mcp.json)
  for (const configured of sources) {
    if (!configured || !configured.url) continue;
    const { endpoint, token } = splitEndpoint(configured.url);
    if (!endpoint || endpoint.includes('<project-ref>')) continue;
    if (token) return { endpoint, token }; // a stored token wins; project (closest) beats global
    if (!endpointOnly) endpointOnly = endpoint; // remember the closest tokenless source, keep looking
  }
  if (endpointOnly) {
    // No source stored a token — the committable web .mcp.json is exactly this
    // case. Fall back to the env token so the local CLI still authenticates.
    return { endpoint: endpointOnly, token: process.env.LOREKIT_TOKEN || null };
  }

  // Fallback: `mcp.endpoint` in .lorekit.json — a committable URL without token.
  // Token still comes from .mcp.json or LOREKIT_TOKEN.
  const lorekitJson = readLorekitJson(root);
  const committedEndpoint =
    lorekitJson && typeof lorekitJson['mcp.endpoint'] === 'string'
      ? lorekitJson['mcp.endpoint'].trim()
      : null;
  if (committedEndpoint && !committedEndpoint.includes('<project-ref>')) {
    return {
      endpoint: committedEndpoint,
      token: process.env.LOREKIT_TOKEN || null,
    };
  }

  return resolveConnection({});
}

// Read .lorekit.json from the repo root without throwing. Exported so other
// CLI modules can read per-repo config without duplicating the same try/catch.
// control.mjs uses its own internal readJson(file) for historical reasons and
// does not import this — that is a known duplication, not a bug.
export function readLorekitJson(root) {
  const file = path.join(root, '.lorekit.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}
