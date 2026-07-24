// `lorekit doctor` — verify the skill install and the LoreKit MCP connection.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  SKILL_NAME,
  resolveProjectRoot,
  skillInstallDir,
  readLorekitServer,
  readMcpConfig,
  resolveConnection,
  tokenKind,
} from './config.mjs';
import { splitEndpoint, mcpCall } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
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
  record(major >= 18 ? 'pass' : 'fail', 'node runtime', `v${process.versions.node}${major < 18 ? ' — need v18+ for fetch' : ''}`);

  // 2. Skill installed.
  const skillMd = path.join(skillInstallDir(root), 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    record('pass', `skill ${SKILL_NAME}`, path.relative(root, skillMd) || skillMd);
  } else {
    record('fail', `skill ${SKILL_NAME}`, 'not found — run `lorekit install`');
  }

  // 3. Connection config: prefer explicit flags/env, else .mcp.json.
  const override = resolveConnection(args);
  const mcp = readMcpConfig(root);
  const configured = mcp.valid ? readLorekitServer(root) : null;
  const fromMcp = configured ? splitEndpoint(configured.url) : { endpoint: null, token: null };

  const endpoint = override.endpoint || fromMcp.endpoint;
  const token = override.token || fromMcp.token;

  if (mcp.present && !mcp.valid) {
    record('fail', '.mcp.json', 'invalid JSON — fix it or re-run `lorekit install`');
  } else if (configured) {
    record('pass', '.mcp.json', 'lorekit server configured');
  } else {
    record('warn', '.mcp.json', 'no lorekit server entry — run `lorekit install`');
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

  // 4. Connectivity.
  if (endpoint && !endpoint.includes('<project-ref>') && token) {
    const res = await mcpCall(endpoint, token, 'tools/list', {});
    if (res.networkError) {
      record('fail', 'connectivity', res.networkError);
    } else if (res.ok) {
      const tools = res.result && Array.isArray(res.result.tools) ? res.result.tools.length : null;
      record('pass', 'connectivity', tools !== null ? `reachable, ${tools} tools` : 'reachable');
    } else if (res.error && AUTH_CODES.has(res.error.code)) {
      record('fail', 'connectivity', `auth rejected (${res.error.code}) — check your token`);
    } else if (res.error) {
      // Reached the server and got a JSON-RPC envelope back; auth passed.
      record('warn', 'connectivity', `reachable, server said: ${res.error.message || res.error.code}`);
    } else {
      record('warn', 'connectivity', `unexpected response (HTTP ${res.httpStatus})`);
    }

    // 5. Optional deep round-trip (write → read → clean up). Needs a rw token.
    if (args.deep) {
      await deepCheck(endpoint, token, root, record);
    }
  } else {
    record('warn', 'connectivity', 'skipped — need a valid endpoint and token');
  }

  // 6. Scope.
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
    log(`  ${failures ? c.red(failures + ' failed') : c.green('0 failed')}, ${warnings ? c.yellow(warnings + ' warning(s)') : '0 warnings'}.`);
  }
  return failures === 0 ? 0 : 1;
}

async function deepCheck(endpoint, token, root, record) {
  if (tokenKind(token) !== 'read-write') {
    record('warn', 'round-trip', 'skipped — needs a read+write token');
    return;
  }
  const scope = deriveScope(root);
  const writeScope = scope.repoScope || 'global';
  const key = 'lorekit-memory::doctor-check';
  const value = 'LoreKit doctor round-trip check. Safe to delete.';

  const w = await mcpCall(endpoint, token, 'tools/call', {
    name: 'memory.write',
    arguments: { scope: writeScope, key, value, tags: ['skill::lorekit-memory', 'source::doctor'], trigger: 'manual' },
  });
  if (!w.ok) {
    record('fail', 'round-trip', `write failed: ${w.error ? w.error.message || w.error.code : w.networkError}`);
    return;
  }
  const r = await mcpCall(endpoint, token, 'tools/call', {
    name: 'memory.read',
    arguments: { scope: writeScope, key },
  });
  const readBack = r.ok && JSON.stringify(r.result || '').includes('round-trip');
  record(readBack ? 'pass' : 'warn', 'round-trip', readBack ? `wrote + read back in ${writeScope}` : 'wrote, but read-back was inconclusive');

  // Clean up.
  await mcpCall(endpoint, token, 'tools/call', {
    name: 'memory.delete',
    arguments: { scope: writeScope, key, force: true },
  });
}
