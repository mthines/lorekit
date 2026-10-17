// The CLI smoke harness: a throwaway sandbox per run, a way to run the REAL
// `bin/lorekit.mjs` in it, a stdio-MCP driver, and the remote cleanup ledger.
//
// Nothing here knows which commands exist — that is `cases.mjs`'s job. Not a
// test file (no `.test.mjs`), so `node --test test/*.test.mjs` never runs it on
// its own; `cli-smoke.test.mjs` and `run.mjs` import it.
//
// Zero dependencies, like the CLI it drives.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CLI_BIN = fileURLToPath(new URL('../../bin/lorekit.mjs', import.meta.url));

/** The production Supabase project (CLAUDE.md → Endpoints). The remote lane WRITES, so it refuses this. */
export const PRODUCTION_REF = 'pqokxlhvnosogizsjztg';

// Operator configuration that must never leak into a smoke run: an ambient
// LOREKIT_TOKEN / LOREKIT_MCP_URL usually points at production, and a BYOD
// LOREKIT_STORAGE_* would retarget `bootstrap`. Telemetry knobs
// (LOREKIT_TELEMETRY_TOKEN, LOREKIT_CORRELATION_ID, DEPLOYMENT_ENVIRONMENT) are
// kept, so a deploy-time run stays observable the way the other smokes are.
const STRIPPED_ENV = /^(LOREKIT_(MCP_URL|TOKEN|MODE|HOME|STORE|APP_URL|STORAGE_.*)|CLAUDE_.*)$/;

function baseEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.test(k)));
}

/**
 * Which auth tier a credential belongs to, from the string alone — the same
 * rule scripts/smoke/smoke-mcp-tools.mjs uses. `purge` / `purge-expired` are
 * account-wide sweeps: scoped to ONE user on an `lk_*` token, but to nobody on a
 * service-role key, where they would reach every account on a shared project.
 */
export function credentialTier(token) {
  if (!token) return 'none';
  if (token.startsWith('lk_')) return 'api_key';
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.role === 'service_role' ? 'service' : 'user';
  } catch {
    return 'service';
  }
}

/**
 * A fresh sandbox: its own HOME (so `~/.claude`, `~/.lorekit` and shell rc files
 * are throwaway) and a git-initialised project directory whose name gives the
 * run a unique project scope, `project::cli-smoke-<runId>`.
 */
export function createContext({ lane, endpoint = null, token = null }) {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'lorekit-cli-smoke-'));
  const home = path.join(root, 'home');
  const dir = path.join(root, `cli-smoke-${runId}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  // Lesson keys look like `smoke-<epoch-ms>-<name>`: the shape
  // scripts/smoke/smoke-cleanup.mjs recognises (SMOKE_ARTEFACT_PATTERN, matched
  // on the key), so a remote run killed before its cleanup leaves nothing the
  // sweeper cannot find.
  const stamp = Date.now();
  return {
    lane,
    runId,
    /** @param {string} name */
    key: (name) => `smoke-${stamp}-${name}`,
    root,
    home,
    dir,
    scope: `project::cli-smoke-${runId}`,
    endpoint,
    token,
    tier: credentialTier(token),
    /** Values a case hands to a later case (a policy id, say). */
    state: {},
    /** [scope, key] pairs written to the REMOTE store — hard-deleted in cleanup. */
    written: new Map(),
    /** Retention-policy ids created on the remote — deleted in cleanup. */
    policies: new Set(),
  };
}

export function disposeContext(ctx) {
  rmSync(ctx.root, { recursive: true, force: true });
}

/** Run `lorekit <args>` in the sandbox. Never throws on a non-zero exit. */
export function runCli(ctx, args, { input, env = {} } = {}) {
  const remote = ctx.lane === 'remote';
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: ctx.dir,
    input,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...baseEnv(),
      HOME: ctx.home,
      USERPROFILE: ctx.home,
      LOREKIT_HOME: path.join(ctx.home, '.lorekit'),
      LOREKIT_MODE: remote ? 'remote' : 'local',
      LOREKIT_MCP_URL: remote ? ctx.endpoint : '',
      LOREKIT_TOKEN: remote ? ctx.token : '',
      CI: '1',
      NO_COLOR: '1',
      ...env,
    },
  });
  return {
    args,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    error: res.error,
  };
}

function describe(r) {
  const tail = r.output.length > 1500 ? `…${r.output.slice(-1500)}` : r.output;
  return `\`lorekit ${r.args.join(' ')}\` exited ${r.code}${r.error ? ` (${r.error.message})` : ''}\n${tail}`;
}

/**
 * The assertion helpers every case receives. Each one runs the CLI, checks the
 * exit code, and says exactly which command did what when it does not hold.
 */
export function cliHelpers(ctx) {
  const run = (args, opts) => runCli(ctx, args, opts);
  return {
    run,
    /** Exit 0; returns stdout + stderr. */
    ok(args, opts) {
      const r = run(args, opts);
      assert.equal(r.code, 0, describe(r));
      return r.output;
    },
    /** Exit `code` (default 0) with `--json` appended; returns the parsed stdout. */
    json(args, { code = 0, ...opts } = {}) {
      const r = run([...args, '--json'], opts);
      assert.equal(r.code, code, describe(r));
      try {
        return JSON.parse(r.stdout);
      } catch {
        assert.fail(`stdout is not JSON — ${describe(r)}`);
      }
    },
    /** A non-zero exit whose output matches `pattern`: the command refused, and said why. */
    fails(args, pattern, opts) {
      const r = run(args, opts);
      assert.notEqual(r.code, 0, `expected a non-zero exit — ${describe(r)}`);
      assert.match(r.output, pattern, describe(r));
      return r.output;
    },
  };
}

/**
 * Drive `lorekit mcp` (the local stdio MCP server) through one session:
 * initialize, tools/list, then each call in order. Returns the advertised tool
 * names and each call's unwrapped result — `{ ok, value }` mirroring how
 * smoke-mcp-tools.mjs reads a `tools/call` answer (an `isError` result and a
 * JSON-RPC error both count as refused).
 */
export function runMcp(ctx, calls) {
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: i + 3,
      method: 'tools/call',
      params: { name: c.name, arguments: c.arguments ?? {} },
    })),
  ];
  const r = runCli(ctx, ['mcp'], { input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n` });
  const byId = new Map();
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) byId.set(msg.id, msg);
    } catch {
      // stdout must carry ONLY JSON-RPC frames; anything else breaks every client.
      assert.fail(`\`lorekit mcp\` wrote a non-JSON line to stdout: ${line.slice(0, 200)}`);
    }
  }
  const unwrap = (msg) => {
    if (!msg) return { ok: false, value: null, error: 'no response' };
    if (msg.error) return { ok: false, value: null, error: msg.error.message };
    const text = msg.result?.content?.[0]?.text;
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* non-JSON text is returned verbatim */
    }
    const refused = msg.result?.isError === true || (value && typeof value === 'object' && value.ok === false);
    return { ok: !refused, value, error: refused ? (value?.error ?? text) : null };
  };
  return {
    code: r.code,
    stderr: r.stderr,
    serverInfo: byId.get(1)?.result?.serverInfo ?? null,
    tools: (byId.get(2)?.result?.tools ?? []).map((t) => t.name),
    results: calls.map((_, i) => unwrap(byId.get(i + 3))),
  };
}

// ── remote cleanup ───────────────────────────────────────────────────────────

async function rpc(ctx, name, args) {
  const res = await fetch(ctx.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${ctx.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  const text = json?.result?.content?.[0]?.text;
  try {
    return { ok: !json?.error && !json?.result?.isError, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: text ?? json };
  }
}

/** Record a remote write so cleanup can hard-delete it whatever the assertions did. */
export function trackRemoteWrite(ctx, scope, key) {
  if (ctx.lane === 'remote') ctx.written.set(JSON.stringify([scope, key]), { scope, key });
}

/**
 * Hard-delete everything the remote lane wrote, and delete its policies.
 * Returns what could not be removed, so the summary can name it.
 */
export async function cleanupRemote(ctx) {
  const residue = [];
  if (ctx.lane !== 'remote') return residue;
  for (const { scope, key } of ctx.written.values()) {
    try {
      const r = await rpc(ctx, 'memory.delete', { scope, key, force: true });
      if (!r.ok) residue.push(`memory ${scope}::${key} (${JSON.stringify(r.value).slice(0, 120)})`);
    } catch (err) {
      residue.push(`memory ${scope}::${key} (${err.name})`);
    }
  }
  for (const id of ctx.policies) {
    try {
      const r = await rpc(ctx, 'policy.delete', { id });
      if (!r.ok) residue.push(`policy ${id}`);
    } catch (err) {
      residue.push(`policy ${id} (${err.name})`);
    }
  }
  return residue;
}
