// `lorekit doctor` — verify the skill install and the resolved memory backend.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  SKILLS,
  resolveProjectRoot,
  skillInstallDir,
  settingsPath,
  CLAUDE_HOOK_EVENTS,
  LOREKIT_HOOK_RE,
  readLorekitServer,
  readMcpConfig,
  tokenKind,
  readLorekitJson,
} from './config.mjs';
import { splitEndpoint } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
import { loadControl } from './control.mjs';
import { createStore } from './store/index.mjs';
import { log, heading, status, c } from './util.mjs';

const AUTH_CODES = new Set([401, 403, -32001]);

export async function doctor(args) {
  const root = resolveProjectRoot(args.dir);
  let failures = 0;
  let warnings = 0;
  const failedChecks = [];
  const record = (kind, label, detail) => {
    if (kind === 'fail') { failures++; failedChecks.push(label); }
    if (kind === 'warn') warnings++;
    status(kind, label, detail);
  };

  heading('LoreKit doctor');
  log(`  project: ${c.dim(root)}\n`);

  // 1. Runtime.
  const major = Number(process.versions.node.split('.')[0]);
  record(
    major >= 18 ? 'pass' : 'fail',
    'node runtime',
    `v${process.versions.node}${major < 18 ? ' — need v18+ for fetch' : ''}`,
  );

  // 2. Skills installed — check every skill the CLI ships, in BOTH the project
  // and the global (~/.claude) locations. `lorekit install --global` writes the
  // skill under home, not the repo, so a project-only check reports a healthy
  // global install as "not found" (exactly the false FAIL a --global setup would
  // hit).
  for (const skill of SKILLS) {
    const skillMd = [
      skillInstallDir(root, 'project', skill.name),
      skillInstallDir(root, 'global', skill.name),
    ]
      .map((dir) => path.join(dir, 'SKILL.md'))
      .find((p) => fs.existsSync(p));
    if (skillMd) {
      const rel = path.relative(root, skillMd);
      record('pass', `skill ${skill.name}`, rel && !rel.startsWith('..') ? rel : prettyPath(skillMd));
    } else {
      record('fail', `skill ${skill.name}`, 'not found — run `lorekit install`');
    }
  }

  // 2.5. Duplicate-hook detection — warn when the same lorekit hook event is
  // wired in both the project settings and the global settings. This causes
  // Claude Code to fire the hook twice per event, producing doubled terminal
  // output. Common after running `lorekit install` once with --project and
  // once with --global (or via the marketplace plugin on top of a CLI install).
  const dupeEvents = detectDuplicateHooks(root);
  if (dupeEvents.length > 0) {
    record(
      'warn',
      'hooks duplicate',
      `${dupeEvents.join(', ')} registered in BOTH project and global settings — ` +
        `Claude Code fires them twice. Remove one scope: ` +
        `run \`lorekit uninstall --project\` or \`lorekit uninstall --global\`.`,
    );
  }

  // 3. Resolved control model — which mode, and who decided it.
  const control = loadControl(root, { env: withOverrides(args) });
  record('info', 'memory mode', `${control.mode}  ${c.dim('— decided by ' + control.decidedBy)}`);
  for (const d of control.denies) {
    record('info', 'deny constraint', `${d.mode} forbidden by ${d.source}`);
  }

  // 4. Mode-specific checks.
  if (control.mode === 'off') {
    record('info', 'memory', 'disabled — hooks and the skill are silent no-ops');
  } else if (control.mode === 'local') {
    await checkLocal(control, root, args, record);
  } else {
    await checkRemote(control, root, args, record);
  }

  // 5. BYOD storage connectivity check.
  await checkBYODStorage(record);

  // 6. Scope.
  const scope = deriveScope(root);
  if (scope.hasRemote) {
    log('');
    record('info', 'read scope', scope.readOrder.join('  →  '));
    record('info', 'write scope', `${scope.repoScope} (default write target)`);
  } else {
    record('warn', 'scope', 'no git remote here — memories fall back to global');
  }

  // 7. Hook instructions — show resolved per-event custom instructions when any are set.
  {
    const instr = control.hooksInstructions || {};
    const EVENTS = ['SessionStart', 'PostToolUseFailure', 'Stop'];
    const configured = EVENTS.filter((ev) => instr[ev]);
    if (configured.length > 0) {
      for (const ev of EVENTS) {
        const text = instr[ev];
        if (text) {
          record('info', `hooks.instructions.${ev}`, c.dim(text.length > 80 ? text.slice(0, 77) + '…' : text));
        } else {
          record('info', `hooks.instructions.${ev}`, c.dim('(not set)'));
        }
      }
    }
  }

  // 8. doctor.require — committed list of checks that MUST pass.
  //    Useful as a CI gate: any check in the list that did not pass causes a failure.
  const lorekitJson = readLorekitJson(root);
  const required = (Array.isArray(lorekitJson['doctor.require']) ? lorekitJson['doctor.require'] : [])
    .filter((r) => typeof r === 'string');
  for (const req of required) {
    // A required check passes if its label is NOT in failedChecks (it either
    // passed or was never run; unknown labels get a pass to avoid false failures).
    if (failedChecks.includes(req)) {
      record('fail', 'doctor.require', `required check failed: ${req}`);
    } else {
      record('pass', 'doctor.require', `required check passed: ${req}`);
    }
  }

  // Summary.
  heading('Summary');
  if (failures === 0 && warnings === 0) {
    log(`  ${c.green('All checks passed.')} LoreKit memory is ready.`);
  } else {
    log(
      `  ${failures ? c.red(failures + ' failed') : c.green('0 failed')}, ${
        warnings ? c.yellow(warnings + ' warning(s)') : '0 warnings'
      }.`,
    );
  }
  const exitCode = failures === 0 ? 0 : 1;
  return { exitCode, 'lorekit.cli.doctor.failed_checks': failedChecks };
}

// Merge doctor's --endpoint / --token flags into the env the resolver reads, so
// an explicit connection flag is honoured without a separate resolution path.
function withOverrides(args) {
  const env = { ...process.env };
  if (args.endpoint) env.LOREKIT_MCP_URL = args.endpoint;
  if (args.token) env.LOREKIT_TOKEN = args.token;
  if (args.mode) env.LOREKIT_MODE = args.mode;
  if (args.store) env.LOREKIT_STORE = args.store;
  return env;
}

// Abbreviate the user's home directory to `~` for readable paths.
function prettyPath(p) {
  const home = os.homedir();
  return p && home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

async function checkLocal(control, root, args, record) {
  const store = createStore(control);
  const scope = deriveScope(root);
  const scopes = [...new Set([...scope.readOrder, scope.branchScope, scope.repoScope])].filter(
    Boolean,
  );

  // Home tier — per-user, cross-repo, always available.
  record('pass', 'home store', prettyPath(store.homeDir));
  const homeCount = await store.home.count(scopes);
  record('info', 'home entries', `${homeCount} ${homeCount === 1 ? 'memory' : 'memories'}`);

  // Project tier — opt-in; active only when its directory exists.
  const projRel = path.relative(root, store.projectDir) || store.projectDir;
  if (store.projectActive()) {
    const sharing = gitTracked(root, store.projectDir)
      ? 'committed — shared with the team'
      : 'gitignored — private to your checkout';
    record('pass', 'project store', projRel);
    const projCount = await store.project.count(scopes);
    record('info', 'project entries', `${projCount} ${projCount === 1 ? 'memory' : 'memories'} — ${sharing}`);
  } else {
    record(
      'info',
      'project store',
      `${projRel} — not opted-in (create it to persist repo/branch memories here)`,
    );
  }

  if (args.deep) await deepCheckLocal(store, scope, record);
}

async function checkRemote(control, root, args, record) {
  const override = { endpoint: args.endpoint || null, token: args.token || null };
  const mcp = readMcpConfig(root);
  const configured = mcp.valid ? readLorekitServer(root) : null;
  const fromMcp = configured ? splitEndpoint(configured.url) : { endpoint: null, token: null };

  const endpoint = override.endpoint || fromMcp.endpoint || control.connection.endpoint;
  const token = override.token || fromMcp.token || control.connection.token;

  if (mcp.present && !mcp.valid) {
    record('fail', '.mcp.json', 'invalid JSON — fix it or re-run `lorekit install`');
  } else if (configured) {
    record('pass', '.mcp.json', 'lorekit server configured');
  } else {
    record('warn', '.mcp.json', 'no lorekit server entry — using env/flags');
  }

  if (!endpoint) {
    record('fail', 'endpoint', 'none — set it in .mcp.json or pass --endpoint');
  } else if (endpoint.includes('<project-ref>')) {
    record('fail', 'endpoint', `still a placeholder: ${endpoint}`);
  } else {
    record('pass', 'endpoint', endpoint);
  }

  const kind = tokenKind(token);
  if (kind === 'none') record('fail', 'token', 'none configured');
  else if (kind === 'read-only') record('warn', 'token', 'read-only (lk_ro_*) — reads only, no writes');
  else if (kind === 'write-only') record('warn', 'token', 'write-only (lk_wo_*) — writes only, no reads');
  else if (kind === 'unknown') record('warn', 'token', 'unrecognized prefix (expected lk_rw_* / lk_ro_* / lk_wo_*)');
  else record('pass', 'token', 'read+write (lk_rw_*)');

  // Connectivity, through the store.
  const store = createStore({ mode: 'remote', connection: { endpoint, token } });
  if (endpoint && !endpoint.includes('<project-ref>') && token) {
    const res = await store.ping();
    if (res.networkError) {
      record('fail', 'connectivity', res.networkError);
    } else if (res.ok) {
      const tools = res.result && Array.isArray(res.result.tools) ? res.result.tools.length : null;
      record('pass', 'connectivity', tools !== null ? `reachable, ${tools} tools` : 'reachable');
    } else if (res.error && AUTH_CODES.has(res.error.code)) {
      record('fail', 'connectivity', `auth rejected (${res.error.code}) — check your token`);
    } else if (res.error) {
      record('warn', 'connectivity', `reachable, server said: ${res.error.message || res.error.code}`);
    } else {
      record('warn', 'connectivity', `unexpected response (HTTP ${res.httpStatus})`);
    }

    if (args.deep) await deepCheckRemote(store, root, record);
  } else {
    record('warn', 'connectivity', 'skipped — need a valid endpoint and token');
  }
}

async function deepCheckRemote(store, root, record) {
  if (tokenKind(store.token) !== 'read-write') {
    record('warn', 'round-trip', 'skipped — needs a read+write token');
    return;
  }
  const scope = deriveScope(root);
  const writeScope = scope.repoScope || 'global';
  const key = 'lorekit-memory::doctor-check';

  const w = await store.write({
    scope: writeScope,
    key,
    value: 'LoreKit doctor round-trip check. Safe to delete.',
    tags: ['skill::lorekit-memory', 'source::doctor'],
    trigger: 'manual',
  });
  if (!w.ok) {
    record('fail', 'round-trip', `write failed: ${w.error ? w.error.message || w.error.code : w.networkError}`);
    return;
  }
  const r = await store.read({ scope: writeScope, key });
  const readBack = r.ok && JSON.stringify(r.entry || '').includes('round-trip');
  record(
    readBack ? 'pass' : 'warn',
    'round-trip',
    readBack ? `wrote + read back in ${writeScope}` : 'wrote, but read-back was inconclusive',
  );
  await store.delete({ scope: writeScope, key, force: true });
}

async function deepCheckLocal(store, scope, record) {
  const writeScope = scope.repoScope || 'global';
  const key = 'lorekit-memory::doctor-check';
  const w = await store.write({
    scope: writeScope,
    key,
    value: 'LoreKit doctor round-trip check. Safe to delete.',
    tags: ['skill::lorekit-memory', 'source::doctor'],
    trigger: 'manual',
  });
  const r = await store.read({ scope: writeScope, key });
  const readBack = w.ok && r.ok && r.entry && String(r.entry.value).includes('round-trip');
  record(
    readBack ? 'pass' : 'warn',
    'round-trip',
    readBack ? `wrote + read back in ${writeScope}` : 'write/read-back was inconclusive',
  );
  await store.delete({ scope: writeScope, key, force: true });
}

async function checkBYODStorage(record) {
  const storageUrl = process.env['LOREKIT_STORAGE_URL'];
  const storageAnonKey = process.env['LOREKIT_STORAGE_ANON_KEY'];

  if (!storageUrl && !storageAnonKey) {
    // No BYOD configured — skip silently (not an error, just not applicable).
    return;
  }

  if (storageUrl && !storageAnonKey) {
    record('fail', 'byod storage', 'LOREKIT_STORAGE_URL is set but LOREKIT_STORAGE_ANON_KEY is missing');
    return;
  }

  if (!storageUrl && storageAnonKey) {
    record('fail', 'byod storage', 'LOREKIT_STORAGE_ANON_KEY is set but LOREKIT_STORAGE_URL is missing');
    return;
  }

  // Both are set — try to connect and do a simple read.
  try {
    // Dynamic import so the main doctor path stays zero-dependency when BYOD is unused.
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(storageUrl, storageAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error } = await db.from('memories').select('id').limit(1);
    if (!error) {
      record('pass', 'byod storage', 'storage ok');
    } else if (error.code === '42P01') {
      record('fail', 'byod storage', 'schema not applied — run `lorekit bootstrap`');
    } else {
      record('fail', 'byod storage', `storage error: ${error.message}`);
    }
  } catch (e) {
    record('fail', 'byod storage', `storage error: ${e && e.message ? e.message : String(e)}`);
  }
}

// Returns the list of CLAUDE_HOOK_EVENTS whose lorekit hook command appears in
// BOTH the project settings file (.claude/settings.json) and the global one
// (~/.claude/settings.json). An empty array means no duplicates — healthy.
function detectDuplicateHooks(root) {
  const dupes = [];
  const projectFile = settingsPath(root, 'project');
  const globalFile = settingsPath(root, 'global');

  let projectHooks = {};
  let globalHooks = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    if (cfg && typeof cfg.hooks === 'object') projectHooks = cfg.hooks;
  } catch { /* absent or unparseable — treat as empty */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
    if (cfg && typeof cfg.hooks === 'object') globalHooks = cfg.hooks;
  } catch { /* absent or unparseable — treat as empty */ }

  for (const event of CLAUDE_HOOK_EVENTS) {
    const hasInProject = hooksForEvent(projectHooks, event).some((cmd) => LOREKIT_HOOK_RE.test(cmd));
    const hasInGlobal = hooksForEvent(globalHooks, event).some((cmd) => LOREKIT_HOOK_RE.test(cmd));
    if (hasInProject && hasInGlobal) dupes.push(event);
  }
  return dupes;
}

// Extract the flat list of hook command strings for one event from a hooks
// object. Handles the nested-group shape Claude Code uses:
// { [event]: [ { hooks: [ { type, command } ] } ] }
function hooksForEvent(hooksObj, event) {
  const groups = Array.isArray(hooksObj[event]) ? hooksObj[event] : [];
  const commands = [];
  for (const group of groups) {
    const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
    for (const h of inner) {
      if (h && typeof h.command === 'string') commands.push(h.command);
    }
  }
  return commands;
}

function gitTracked(root, dir) {
  // Heuristic: is the store dir ignored by git? If `git check-ignore` names it,
  // it is private; otherwise it will be committed (team-shared).
  try {
    execFileSync('git', ['check-ignore', '-q', dir], { cwd: root, stdio: 'ignore' });
    return false; // ignored → private
  } catch {
    return true; // not ignored → tracked/committed
  }
}
