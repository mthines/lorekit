// The control model: decide the memory mode (off | local | remote), the store
// target, who decided, and which deny constraints are active.
//
// Two layers of config, two kinds of statement:
//   - a SELECT (`mode`) chooses a mode within what is allowed;
//   - a DENY forbids a mode outright and can never be overridden.
//
// Deny always wins. Denies are a UNION across every source and only ever
// accumulate — so a user-level "never remote" (privacy/compliance) is a ceiling
// no repo config or default can lift, and "never local" (no `.lore/` in the
// tree / CI) is enforceable the same way. `off` is always allowed (you cannot
// deny "disabled"), so it is the terminal fallback.
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
  for (const m of asList(userConfig.deny)) addDeny(m, 'user config (~/.agent-memory/config.json)');
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
  push(userConfig.mode ?? userConfig.backend, 'user config (~/.agent-memory/config.json)');
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

  // 4. Store target.
  let storeTarget = null;
  if (chosen.mode === 'local') storeTarget = resolveStoreDir({ env, userConfig, repoConfig, root });
  else if (chosen.mode === 'remote') storeTarget = connection.endpoint || null;

  return { mode: chosen.mode, storeTarget, decidedBy, denies, connection };
}

function resolveStoreDir({ env, userConfig, repoConfig, root }) {
  const raw = env.LOREKIT_STORE || userConfig.store || repoConfig.store || '.lore';
  return path.isAbsolute(raw) ? raw : path.join(root, raw);
}

// IO wrapper — load env + config files, derive the connection, then resolve.
export function loadControl(root, { env = process.env } = {}) {
  const userConfig = readJson(path.join(userConfigDir(env), 'config.json'));
  const repoConfig = readJson(path.join(root, '.lorekit.json'));
  const conn = resolveProjectConnection(root, splitEndpoint);
  const usable = Boolean(
    conn.endpoint && conn.token && !String(conn.endpoint).includes('<project-ref>'),
  );
  const connection = { endpoint: conn.endpoint, token: conn.token, usable };
  return resolveControl({ env, userConfig, repoConfig, connection, root });
}

function userConfigDir(env) {
  return env.LOREKIT_HOME || path.join(os.homedir(), '.agent-memory');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}
