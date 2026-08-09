// Spawns the real `lorekit mcp` stdio server as a child process and drives the
// MCP handshake (initialize → tools/list → tools/call) over newline-delimited
// JSON-RPC, asserting a memory.write → read/list round-trip against a temp
// `.lore/` store, plus the error and robustness contracts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listScopes } from '../src/mcp-server.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-mcp-'));
}

// Spawn the server, feed it `raw` (verbatim) followed by the JSON-encoded
// `frames`, then close stdin so it exits. Resolve with the parsed responses.
function serve(frames, { store, home = tmpDir(), mode = 'local', raw = '' } = {}) {
  return new Promise((resolve, reject) => {
    // Isolate BOTH tiers into temp dirs so a global-scoped write (which routes
    // to the home tier) never touches the real ~/.lorekit.
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: { ...process.env, LOREKIT_MODE: mode, LOREKIT_STORE: store, LOREKIT_HOME: home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', () => {
      const messages = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      resolve({ messages, err, out, home, store });
    });
    const payload = raw + frames.map((f) => JSON.stringify(f)).join('\n') + (frames.length ? '\n' : '');
    child.stdin.write(payload);
    child.stdin.end();
  });
}

const byId = (messages) => new Map(messages.filter((m) => m.id !== null && m.id !== undefined).map((m) => [m.id, m]));

test('initialize → tools/list → write/read/list round-trip over stdio', async () => {
  const store = tmpDir();
  const { messages, home } = await serve(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory.write', arguments: { scope: 'global', key: 'k1', value: 'hello', tags: ['t'] } },
      },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory.read', arguments: { scope: 'global', key: 'k1' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'global' } } },
    ],
    { store },
  );

  const m = byId(messages);

  const init = m.get(1);
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'lorekit-local');
  assert.deepEqual(init.result.capabilities, { tools: {} });

  const list = m.get(2);
  // 7 memory.* tools + 4 org.* tools
  assert.equal(list.result.tools.length, 11);
  assert.ok(list.result.tools.some((t) => t.name === 'memory.write'));
  assert.ok(list.result.tools.some((t) => t.name === 'memory.archive'));
  assert.ok(list.result.tools.some((t) => t.name === 'org.create'));
  assert.ok(list.result.tools.some((t) => t.name === 'org.list'));
  assert.ok(list.result.tools.some((t) => t.name === 'org.rename'));
  assert.ok(list.result.tools.some((t) => t.name === 'org.delete'));

  // The notification produced no response — only ids 1..5 came back.
  assert.deepEqual([...m.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  const written = JSON.parse(m.get(3).result.content[0].text);
  assert.equal(written.ok, true);

  const read = JSON.parse(m.get(4).result.content[0].text);
  assert.equal(read.entry.value, 'hello');

  const listed = JSON.parse(m.get(5).result.content[0].text);
  assert.deepEqual(listed.entries.map((e) => e.key), ['k1']);

  // The write actually hit disk. A `global`-scoped write routes to the HOME
  // tier (two-tier model), not the project store dir.
  assert.ok(fs.existsSync(path.join(home, 'global')));
});

test('a large memory.list frame survives exit (big-scope stdout is not truncated)', async () => {
  // Regression: `process.exit()` truncates stdout still buffered for a pipe, so
  // the FINAL and largest frame — a `memory.list` over a big scope — was
  // silently dropped and the client saw "no response". It reproduced
  // deterministically once the response crossed ~½ MB; production's `global`
  // scope had grown past that and rolled back two deploys before the exit path
  // learned to flush first. Write enough large memories that the list response
  // is several MB, then assert the frame comes back whole.
  const store = tmpDir();
  const BIG = 'x'.repeat(50 * 1024); // 50 KB per value
  const COUNT = 50; // → ~2.5 MB list response, well past the truncation threshold
  const writes = Array.from({ length: COUNT }, (_, i) => ({
    jsonrpc: '2.0',
    id: 100 + i,
    method: 'tools/call',
    params: { name: 'memory.write', arguments: { scope: 'global', key: `big-${i}`, value: BIG } },
  }));

  const { messages } = await serve(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      ...writes,
      { jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'global' } } },
    ],
    { store },
  );

  const listMsg = byId(messages).get(999);
  assert.ok(listMsg, 'memory.list produced no response — the final frame was truncated on exit');
  const listed = JSON.parse(listMsg.result.content[0].text);
  assert.equal(listed.ok, true);
  assert.equal(listed.entries.length, COUNT);
  // Every value came through whole, not clipped mid-frame.
  assert.ok(listed.entries.every((e) => e.value.length === BIG.length));
});

test('unknown method returns a JSON-RPC method-not-found error', async () => {
  const store = tmpDir();
  const { messages } = await serve([{ jsonrpc: '2.0', id: 1, method: 'does/not/exist', params: {} }], { store });
  const m = byId(messages).get(1);
  assert.equal(m.error.code, -32601);
  assert.match(m.error.message, /Method not found/);
});

test('unknown tool returns a JSON-RPC error, not a crash', async () => {
  const store = tmpDir();
  const { messages } = await serve(
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory.nope', arguments: {} } }],
    { store },
  );
  const m = byId(messages).get(1);
  assert.equal(m.error.code, -32601);
  assert.match(m.error.message, /Unknown tool/);
});

test('a malformed frame does not crash the server; later frames still work', async () => {
  const store = tmpDir();
  const { messages } = await serve([{ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }], {
    store,
    raw: 'this is not json\n{ also bad\n',
  });
  // Each garbage line yielded a parse error (id null), and the valid initialize
  // that followed still got its response.
  assert.ok(messages.some((x) => x.error && x.error.code === -32700 && x.id === null));
  assert.ok(messages.some((x) => x.id === 7 && x.result && x.result.protocolVersion === '2024-11-05'));
});

test('off mode: memory tools are absent but org tools are still advertised', async () => {
  const store = tmpDir();
  const { messages } = await serve(
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'global' } } },
    ],
    { store, mode: 'off' },
  );
  const m = byId(messages);
  const tools = m.get(1).result.tools;
  // In off mode memory tools are not advertised, but org tools always are.
  assert.ok(!tools.some((t) => t.name.startsWith('memory.')), 'memory tools should not appear in off mode');
  assert.ok(tools.some((t) => t.name === 'org.create'), 'org.create should appear in off mode');
  assert.ok(tools.some((t) => t.name === 'org.list'), 'org.list should appear in off mode');
  assert.ok(tools.some((t) => t.name === 'org.rename'), 'org.rename should appear in off mode');
  assert.ok(tools.some((t) => t.name === 'org.delete'), 'org.delete should appear in off mode');
  // memory.list still returns the "disabled" error
  const call = m.get(2);
  assert.equal(call.result.isError, true);
  assert.match(JSON.parse(call.result.content[0].text).error, /disabled/);
});

test('local mode: org tools are advertised alongside memory tools', async () => {
  const store = tmpDir();
  const { messages } = await serve(
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }],
    { store, mode: 'local' },
  );
  const m = byId(messages);
  const tools = m.get(1).result.tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('memory.write'));
  assert.ok(names.includes('org.create'));
  assert.ok(names.includes('org.list'));
  assert.ok(names.includes('org.rename'));
  assert.ok(names.includes('org.delete'));
});

test('org.* call without remote endpoint returns a clear error, not a crash', async () => {
  const store = tmpDir();
  // No LOREKIT_MCP_URL / LOREKIT_TOKEN configured — org call should return
  // { ok: false, error: '...' } wrapped in isError rather than crashing.
  const { messages } = await serve(
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'org.create', arguments: { slug: 'x', name: 'X' } } }],
    { store, mode: 'local' },
  );
  const m = byId(messages).get(1);
  assert.equal(m.result.isError, true);
  const payload = JSON.parse(m.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /remote LoreKit endpoint/);
});

test('org.unknown tool returns a JSON-RPC error, not a crash', async () => {
  const store = tmpDir();
  const { messages } = await serve(
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'org.nope', arguments: {} } }],
    { store },
  );
  const m = byId(messages).get(1);
  assert.equal(m.error.code, -32601);
  assert.match(m.error.message, /Unknown tool/);
});

// ── memory.scopes: the store-wide inventory ──────────────────────────────────
// An agent that cannot enumerate scopes cannot know what it does not know:
// every other read tool needs a scope named up front, so without this the only
// reachable lore is the lore whose scope the agent could already name.

test('memory.scopes is advertised and returns the store-wide inventory', async () => {
  const store = tmpDir();
  const home = tmpDir();
  const { messages } = await serve(
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      // Seed three scopes, one of them with two memories.
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.write', arguments: { scope: 'global', key: 'g1', value: 'v' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.write', arguments: { scope: 'repo::acme/widget', key: 'r1', value: 'v' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory.write', arguments: { scope: 'repo::acme/widget', key: 'r2', value: 'v' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory.scopes', arguments: {} } },
    ],
    { store, home },
  );

  const m = byId(messages);

  const def = m.get(1).result.tools.find((t) => t.name === 'memory.scopes');
  assert.ok(def, 'memory.scopes is advertised in tools/list');
  // Takes no arguments — an inventory has nothing to narrow by.
  assert.deepEqual(def.inputSchema, { type: 'object', properties: {} });

  const res = m.get(5);
  assert.ok(!res.result.isError, 'a successful enumeration is not a tool error');
  const payload = JSON.parse(res.result.content[0].text);
  const counts = Object.fromEntries(payload.scopes.map((s) => [s.scope, s.count]));
  assert.deepEqual(counts, { global: 1, 'repo::acme/widget': 2 });
  // Store-wide, not cwd-scoped: `repo::acme/widget` is not this working
  // directory's scope and is enumerated anyway.
  assert.ok(!('note' in payload), 'a healthy enumeration carries no note');
});

test('memory.scopes is not advertised when the memory store is off', async () => {
  // It is a memory tool, so it follows the same gating as the rest — `off`
  // advertises the org tools only.
  const { messages } = await serve(
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }],
    { store: tmpDir(), mode: 'off' },
  );
  const tools = byId(messages).get(1).result.tools.map((t) => t.name);
  assert.ok(!tools.includes('memory.scopes'));
  assert.ok(tools.includes('org.list'), 'org tools are still advertised');
});

// The dispatch normaliser, unit-tested against each store shape. `createHandler`
// builds its own store from the control model, so the fakes go straight to the
// exported function — the same one the dispatch table calls.
describe('memory.scopes dispatch', () => {
  test('normalises the local store bare-array shape', async () => {
    const local = { async listScopes() { return [{ scope: 'global', count: 3 }]; } };
    assert.deepEqual(await listScopes(local), {
      ok: true,
      scopes: [{ scope: 'global', count: 3 }],
    });
  });

  test('normalises the remote store envelope shape, keeping last_activity', async () => {
    const remote = {
      async listScopes() {
        return {
          ok: true,
          scopes: [
            { scope: 'global', count: 12, last_activity: '2026-07-30T09:12:00.000Z' },
            { scope: 'repo::a/b', count: 3 },
          ],
        };
      },
    };
    assert.deepEqual(await listScopes(remote), {
      ok: true,
      scopes: [
        { scope: 'global', count: 12, last_activity: '2026-07-30T09:12:00.000Z' },
        // OMITTED, never null — a consumer can tell "this store does not report
        // freshness" from "this scope has none".
        { scope: 'repo::a/b', count: 3 },
      ],
    });
  });

  test('degrades to an empty inventory plus a note, never a tool error', async () => {
    // Exit-clean, mirroring the `scopes` command: "I could not enumerate" is a
    // fact about the store, not a failed call, and a model handed a tool error
    // is liable to retry rather than carry on with the lore it can reach.
    const cases = [
      [{ ok: false, unusable: true }, /no usable store/],
      [{ ok: false, networkError: 'ECONNREFUSED' }, /network error: ECONNREFUSED/],
      [{ ok: false, error: { httpStatus: 403 } }, /HTTP 403/],
      [{ ok: false, error: { message: 'permission denied' } }, /permission denied/],
      [{ ok: false }, /could not enumerate/],
      [undefined, /no result/],
    ];
    for (const [result, pattern] of cases) {
      const out = await listScopes({ async listScopes() { return result; } });
      assert.equal(out.ok, true, `ok stays true for ${JSON.stringify(result)}`);
      assert.deepEqual(out.scopes, []);
      assert.match(out.note, pattern);
    }
  });

  test('a throwing store degrades instead of taking the session down', async () => {
    const out = await listScopes({ async listScopes() { throw new Error('disk on fire'); } });
    assert.equal(out.ok, true);
    assert.deepEqual(out.scopes, []);
    assert.match(out.note, /scope enumeration failed: disk on fire/);
  });

  test('a malformed row is coerced rather than propagated', async () => {
    const out = await listScopes({
      async listScopes() { return [{ scope: 'global' }, { scope: 'x', count: 'lots' }, {}]; },
    });
    assert.deepEqual(out.scopes, [
      { scope: 'global', count: 0 },
      { scope: 'x', count: 0 },
      { scope: '', count: 0 },
    ]);
  });

  test('a store with no scopes yields an empty inventory and no note', async () => {
    // Distinct from the failure case above: an empty store is a successful
    // enumeration that found nothing, and must not read as an error.
    const out = await listScopes({ async listScopes() { return []; } });
    assert.deepEqual(out, { ok: true, scopes: [] });
  });
});
