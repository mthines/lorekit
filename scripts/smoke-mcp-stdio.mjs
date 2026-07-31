#!/usr/bin/env node
// Smoke test the robust local stdio MCP transport (`lorekit mcp`) against a live
// backend. Spawns the CLI's stdio server in remote-passthrough mode, drives the
// JSON-RPC handshake, and asserts:
//   1. initialize → serverInfo.name === 'lorekit-local' (the stdio server booted)
//   2. tools/list → the six memory.* tools (the MCP protocol surface is intact)
//   3. memory.list → ok:true (the transport actually reaches the live backend)
//
// This is the offline-robust alternative to `npx -y mcp-remote` that the CLI
// ships (docs/CLAUDE.md), and the transport a `.mcp.json` can point at instead.
// CI runs it in the integration job against the local Supabase; it also works
// against any real endpoint for manual verification:
//
//   node scripts/smoke-mcp-stdio.mjs <endpoint> <token>
//   node scripts/smoke-mcp-stdio.mjs "$LOREKIT_MCP_URL" "$LOREKIT_TOKEN"
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const endpoint = process.argv[2] || process.env.LOREKIT_MCP_URL;
const token = process.argv[3] || process.env.LOREKIT_TOKEN;

if (!endpoint || !token) {
  console.error('usage: smoke-mcp-stdio.mjs <endpoint> <token>  (or set LOREKIT_MCP_URL / LOREKIT_TOKEN)');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'packages', 'cli', 'bin', 'lorekit.mjs');
const EXPECTED_TOOLS = ['memory.write', 'memory.read', 'memory.list', 'memory.search', 'memory.delete', 'memory.archive'];
// Watchdog so this can never hang a timeout-less CI job: the per-call fetch abort
// is ~10s, so a healthy run finishes well under this; if the child stalls or never
// exits, kill it and fail loudly instead of running to the job's 6h ceiling.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60000;

/**
 * Dump the local edge-runtime container log.
 *
 * A function that fails to boot surfaces here only as an opaque
 * `503 BOOT_ERROR: Worker failed to boot (please check logs)` — the actual
 * cause (a module-resolution error, usually) is printed by the container and
 * nowhere else. Without this, a failure is undiagnosable from the CI output
 * alone; that cost five runs across four branches once already.
 *
 * Best-effort: no Docker, no container, or a non-local endpoint just means no
 * extra output. It never changes the exit code.
 */
function dumpEdgeRuntimeLog() {
  if (!/127\.0\.0\.1|localhost/.test(endpoint ?? '')) return;
  try {
    const log = execFileSync(
      'docker',
      ['logs', '--tail', '200', 'supabase_edge_runtime_lorekit'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
    if (log.trim()) console.error(`\n--- supabase_edge_runtime_lorekit (last 200 lines) ---\n${log}`);
  } catch {
    // Docker unavailable, container absent, or the command failed — nothing to add.
  }
}

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  dumpEdgeRuntimeLog();
  process.exit(1);
};

function run() {
  return new Promise((resolve) => {
    // The `mcp` command resolves its connection from the environment / .mcp.json
    // (not from -e/-t flags), so pass the endpoint+token via env. Explicit values
    // win over anything inherited, so this is deterministic on a bare CI runner.
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', LOREKIT_MODE: 'remote', LOREKIT_MCP_URL: endpoint, LOREKIT_TOKEN: token },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`timed out after ${TIMEOUT_MS / 1000}s — the stdio server did not finish (backend unresponsive?). stderr:\n${err}`);
    }, TIMEOUT_MS);
    watchdog.unref?.();

    child.on('error', (e) => fail(`could not spawn lorekit mcp: ${e.message}`));
    child.on('close', () => {
      clearTimeout(watchdog);
      const messages = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolve({ messages, err });
    });

    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'global' } } },
    ];
    child.stdin.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
    child.stdin.end();
  });
}

const { messages, err } = await run();
const byId = new Map(messages.filter((m) => m.id != null).map((m) => [m.id, m]));

// 1. initialize
const init = byId.get(1);
if (!init || !init.result || init.result.serverInfo?.name !== 'lorekit-local') {
  fail(`initialize did not return the lorekit-local server info. stderr:\n${err}`);
}

// 2. tools/list — the six memory.* tools
const list = byId.get(2);
const toolNames = list?.result?.tools?.map((t) => t.name) ?? [];
for (const want of EXPECTED_TOOLS) {
  if (!toolNames.includes(want)) fail(`tools/list is missing "${want}" (got: ${toolNames.join(', ') || 'none'})`);
}

// 3. memory.list — proves the stdio transport reached the live backend.
const call = byId.get(3);
if (!call || call.error) fail(`memory.list errored: ${JSON.stringify(call?.error) || 'no response'}`);
let payload;
try {
  payload = JSON.parse(call.result.content[0].text);
} catch {
  fail(`memory.list returned an unparseable payload: ${JSON.stringify(call.result)}`);
}
if (!payload || payload.ok !== true) fail(`memory.list did not report ok:true — backend passthrough failed: ${JSON.stringify(payload)}`);

console.log(`✓ stdio transport healthy — initialize OK, ${toolNames.length} tools, memory.list reached the backend (${payload.entries?.length ?? 0} entr(y/ies))`);
process.exit(0);
