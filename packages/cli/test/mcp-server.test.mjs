// Spawns the real `lorekit mcp` stdio server as a child process and drives the
// MCP handshake (initialize → tools/list → tools/call) over newline-delimited
// JSON-RPC, asserting a memory.write → read/list round-trip against a temp
// `.lore/` store, plus the error and robustness contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-mcp-'));
}

// Spawn the server, feed it `raw` (verbatim) followed by the JSON-encoded
// `frames`, then close stdin so it exits. Resolve with the parsed responses.
function serve(frames, { store, mode = 'local', raw = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: { ...process.env, LOREKIT_MODE: mode, LOREKIT_STORE: store, NO_COLOR: '1' },
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
      resolve({ messages, err, out });
    });
    const payload = raw + frames.map((f) => JSON.stringify(f)).join('\n') + (frames.length ? '\n' : '');
    child.stdin.write(payload);
    child.stdin.end();
  });
}

const byId = (messages) => new Map(messages.filter((m) => m.id !== null && m.id !== undefined).map((m) => [m.id, m]));

test('initialize → tools/list → write/read/list round-trip over stdio', async () => {
  const store = tmpDir();
  const { messages } = await serve(
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
  assert.equal(list.result.tools.length, 6);
  assert.ok(list.result.tools.some((t) => t.name === 'memory.write'));
  assert.ok(list.result.tools.some((t) => t.name === 'memory.archive'));

  // The notification produced no response — only ids 1..5 came back.
  assert.deepEqual([...m.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  const written = JSON.parse(m.get(3).result.content[0].text);
  assert.equal(written.ok, true);

  const read = JSON.parse(m.get(4).result.content[0].text);
  assert.equal(read.entry.value, 'hello');

  const listed = JSON.parse(m.get(5).result.content[0].text);
  assert.deepEqual(listed.entries.map((e) => e.key), ['k1']);

  // The write actually hit the .lore/ store on disk.
  assert.ok(fs.existsSync(path.join(store, 'global')));
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

test('off mode advertises no tools and reports disabled on a call', async () => {
  const store = tmpDir();
  const { messages } = await serve(
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'global' } } },
    ],
    { store, mode: 'off' },
  );
  const m = byId(messages);
  assert.deepEqual(m.get(1).result.tools, []);
  const call = m.get(2);
  assert.equal(call.result.isError, true);
  assert.match(JSON.parse(call.result.content[0].text).error, /disabled/);
});
