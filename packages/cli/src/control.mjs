// The control model: decide the memory mode (off | local | remote), the store
// target, who decided, and which deny constraints are active. Also resolves
// write-behaviour properties from the config layers:
//
//   scope.defaults  — map of scope-prefix → { tags } applied to every matching write
//   tags.default    — array of tags appended to every write (both layers merged)
//   hooks.disabled  — array of hook event names to suppress (e.g. ["Stop"])
//   hooks.adapter   — explicit adapter override ("claude" | "cursor" | "codex")
//
// Two layers of config, two kinds of statement:
//   - a SELECT (`mode`) chooses a mode within what is allowed;
//   - a DENY forbids a mode outright and can never be overridden.
//
// Deny always wins. Denies are a UNION across every source and only ever
// accumulate — so a user-level "never remote" (privacy/compliance) is a ceiling
// no repo config or default can lift, and "never local" (no `.lorekit/` in the
// tree / CI) is enforceable the same way. `off` is always allowed (you cannot
// deny "disabled"), so it is the terminal fallback.
//
// Local mode is two-tier (mirroring the persistent-memory home + project-shared
// model): a per-user `home` tier at $LOREKIT_HOME (default `~/.lorekit/`) and an
// opt-in per-repo `project` tier at `<repo>/.lorekit/` (overridable with
// $LOREKIT_STORE). The resolved local `storeTarget` is `{ home, project }`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectConnection } from './config.mjs';
import { splitEndpoint } from './mcp.mjs';

export const MODES = ['off', 'local', 'remote'];

// Accept a few friendly spellings, incl. persistent-memory's `backend` values.
export function normalizeMode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['off', 'disabled', 'none', 'false'].includes(s)) return 'off';
  if (['local', 'markdown', 'file', 'files'].includes(s)) return 'local';
  if (['remote', 'lorekit', 'mcp', 'hosted'].includes(s)) return 'remote';
  return null;
}

function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// Pure resolver — no IO. Given the already-loaded config objects, decide.
// Returns { mode, storeTarget, decidedBy, denies, connection }.
export function resolveControl({
  env = {},
  userConfig = {},
  repoConfig = {},
  connection = {},
  root = process.cwd(),
  home = env.LOREKIT_HOME || null,
} = {}) {
  // 1. Denies — union, deny-wins, accumulate (never removable).
  const denies = [];
  const addDeny = (mode, source) => {
    const m = normalizeMode(mode);
    if ((m === 'remote' || m === 'local') && !denies.some((d) => d.mode === m)) {
      denies.push({ mode: m, source });
    }
  };
  for (const m of asList(env.LOREKIT_DENY)) addDeny(m, 'env LOREKIT_DENY');
  for (const m of asList(userConfig.deny)) addDeny(m, 'user config (~/.lorekit/config.json)');
  for (const m of asList(repoConfig.deny)) addDeny(m, 'repo (.lorekit.json)');
  const denied = new Set(denies.map((d) => d.mode));

  // 2. Candidate selections, highest precedence first. An explicit env/flag
  //    outranks a user preference, which outranks the repo default, which
  //    outranks the built-in default.
  const candidates = [];
  const push = (mode, source) => {
    const m = normalizeMode(mode);
    if (m) candidates.push({ mode: m, source });
  };
  push(env.LOREKIT_MODE, 'env LOREKIT_MODE');
  push(userConfig.mode ?? userConfig.backend, 'user config (~/.lorekit/config.json)');
  push(repoConfig.mode ?? repoConfig.backend, 'repo (.lorekit.json)');
  // Built-in default is `remote`: it preserves the pre-control behaviour where
  // reads stay silent until a connection is configured while the retrospective
  // / failure nudges still fire (they are backend-agnostic reminders). `off`
  // is reached only by an explicit selection, or when `remote` is denied.
  push(
    'remote',
    connection.usable
      ? 'default (remote connection configured)'
      : 'default (remote — not yet configured)',
  );
  push('off', 'terminal fallback (all selections denied)');

  // 3. First candidate that is allowed. `off` is never denied, so this always
  //    resolves. A denied higher-precedence selection is silently capped.
  const idx = candidates.findIndex((c) => c.mode === 'off' || !denied.has(c.mode));
  const chosen = candidates[idx];
  const cappedModes = [
    ...new Set(candidates.slice(0, idx).filter((c) => denied.has(c.mode)).map((c) => c.mode)),
  ];
  const decidedBy = cappedModes.length
    ? `${chosen.source} (after deny: ${cappedModes.join(', ')})`
    : chosen.source;

  // 4. Store target. Local mode is two-tier: { home, project }.
  let storeTarget = null;
  if (chosen.mode === 'local') {
    storeTarget = { home: home || null, project: projectDirFrom({ env, userConfig, repoConfig, root }) };
  } else if (chosen.mode === 'remote') {
    storeTarget = connection.endpoint || null;
  }

  // 5. Write-behaviour properties resolved from config layers.
  //    `tags.default` — both layers merged, user supplements repo (no override).
  const tagsDefault = [
    ...asList(repoConfig['tags.default']),
    ...asList(userConfig['tags.default']),
  ].filter((t) => typeof t === 'string' && t.length > 0);

  // `scope.defaults` — repo layer only (team-scoped write policy).
  //    Schema: { "<scope-prefix>": { "tags": [...] } }
  //    Matched against a write's resolved scope using startsWith — no glob dep.
  const scopeDefaults =
    repoConfig['scope.defaults'] && typeof repoConfig['scope.defaults'] === 'object'
      ? repoConfig['scope.defaults']
      : null;

  // `hooks.disabled` — union of both layers (either layer can suppress an event).
  const hooksDisabled = new Set([
    ...asList(repoConfig['hooks.disabled']),
    ...asList(userConfig['hooks.disabled']),
  ]);

  // `hooks.adapter` — repo layer wins over user layer (explicit project override).
  const hooksAdapter =
    (typeof repoConfig['hooks.adapter'] === 'string' && repoConfig['hooks.adapter'].trim()) ||
    (typeof userConfig['hooks.adapter'] === 'string' && userConfig['hooks.adapter'].trim()) ||
    null;

  // `hooks.instructions` — per-event custom text appended to the hook output so
  // teams can embed project-specific guidance directly into the injected context.
  // Both layers contribute: repo instructions come first, user instructions follow
  // (same direction as `tags.default` — repo supplements, user personalises).
  // null for a given event means "no custom instruction for that event".
  const HOOK_EVENTS = ['SessionStart', 'PostToolUseFailure', 'Stop'];
  const hooksInstructions = {};
  {
    const repoInstr =
      (repoConfig['hooks.instructions'] && typeof repoConfig['hooks.instructions'] === 'object')
        ? repoConfig['hooks.instructions'] : {};
    const userInstr =
      (userConfig['hooks.instructions'] && typeof userConfig['hooks.instructions'] === 'object')
        ? userConfig['hooks.instructions'] : {};
    for (const ev of HOOK_EVENTS) {
      const parts = [repoInstr[ev], userInstr[ev]]
        .filter((v) => typeof v === 'string' && v.trim().length > 0);
      hooksInstructions[ev] = parts.length > 0 ? parts.join('\n') : null;
    }
  }

  return {
    mode: chosen.mode,
    storeTarget,
    decidedBy,
    denies,
    connection,
    tagsDefault,
    scopeDefaults,
    hooksDisabled,
    hooksAdapter,
    hooksInstructions,
  };
}

// The per-repo project-tier directory: $LOREKIT_STORE, else a `store` override
// in either config layer, else the default `.lorekit/` at the repo root.
function projectDirFrom({ env, userConfig, repoConfig, root }) {
  const raw = env.LOREKIT_STORE || userConfig.store || repoConfig.store || '.lorekit';
  return path.isAbsolute(raw) ? raw : path.join(root, raw);
}

// Resolve both local-tier directories with IO (reads the config files for a
// `store` override). Used by `migrate` so it works regardless of the active
// mode. `home` is the per-user tier root; `project` is the opt-in repo tier.
export function localStoreDirs(root = process.cwd(), env = process.env) {
  const home = userConfigDir(env);
  const userConfig = readJson(path.join(home, 'config.json'));
  const repoConfig = readJson(path.join(root, '.lorekit.json'));
  return { home, project: projectDirFrom({ env, userConfig, repoConfig, root }) };
}

// Resolve the deny-wins ceiling for the read commands: which section (offline /
// remote) is forbidden outright by an active `deny` constraint. A deny is never
// overridable (see the module header), so this is the single seam `list`,
// `search`, `show`, `stats`, and `diff` share instead of each re-deriving the
// same `control.denies.find(...)` block. Returns the matched deny object
// ({ mode, source }) or null per side — the `source` explains the "why" in each
// command's graceful note. Thin wrapper over `loadControl`, co-located with it.
export function resolveDenies(root, { env = process.env } = {}) {
  const control = loadControl(root, { env });
  const find = (mode) => control.denies.find((d) => d.mode === mode) || null;
  return { localDenied: find('local'), remoteDenied: find('remote') };
}

// IO wrapper — load env + config files, derive the connection, then resolve.
export function loadControl(root, { env = process.env } = {}) {
  const home = userConfigDir(env);
  const userConfig = readJson(path.join(home, 'config.json'));
  const repoConfig = readJson(path.join(root, '.lorekit.json'));
  const conn = resolveProjectConnection(root, splitEndpoint);
  const usable = Boolean(
    conn.endpoint && conn.token && !String(conn.endpoint).includes('<project-ref>'),
  );
  const connection = { endpoint: conn.endpoint, token: conn.token, usable };
  return resolveControl({ env, userConfig, repoConfig, connection, root, home });
}

// The per-user home tier root (also holds config.json): $LOREKIT_HOME, default
// `~/.lorekit`. Moved from the old `~/.agent-memory` location.
function userConfigDir(env) {
  return env.LOREKIT_HOME || path.join(os.homedir(), '.lorekit');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}
