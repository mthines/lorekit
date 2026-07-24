// `lorekit doctor` — verify the skill install and the resolved memory backend.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  SKILL_NAME,
  resolveProjectRoot,
  skillInstallDir,
  readLorekitServer,
  readMcpConfig,
  tokenKind,
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
  const record = (kind, label, detail) => {
    if (kind === 'fail') failures++;
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

  // 2. Skill installed.
  const skillMd = path.join(skillInstallDir(root), 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    record('pass', `skill ${SKILL_NAME}`, path.relative(root, skillMd) || skillMd);
  } else {
    record('fail', `skill ${SKILL_NAME}`, 'not found — run `lorekit install`');
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

  // 5. Scope.
  const scope = deriveScope(root);
  if (scope.hasRemote) {
    record('info', 'read scope', scope.readOrder.join('  →  '));
    record('info', 'write scope', `${scope.repoScope} (default for "went wrong" lessons)`);
  } else {
    record('warn', 'scope', 'no git remote here — lessons fall back to global');
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
  return failures === 0 ? 0 : 1;
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

async function checkLocal(control, root, args, record) {
  const dir = control.storeTarget;
  const rel = path.relative(root, dir) || dir;
  record('pass', 'store path', rel);

  const store = createStore(control);
  const scope = deriveScope(root);
  const scopes = [...new Set([...scope.readOrder, scope.branchScope, scope.repoScope])].filter(
    Boolean,
  );
  const total = await store.count(scopes);
  record('info', 'entries', `${total} lesson(s) across ${scopes.length} scope(s)`);

  if (fs.existsSync(dir)) {
    record('info', 'sharing', gitTracked(root, dir) ? 'committed — shared with the team' : 'present (gitignore it to keep lessons private)');
  } else {
    record('info', 'store', 'not created yet — the first write creates it');
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
  else if (kind === 'unknown') record('warn', 'token', 'unrecognized prefix (expected lk_rw_* / lk_ro_*)');
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
