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

import { listScopes, projectListView, listWithFilters, LIST_PREVIEW_CHARS, advertise } from '../src/mcp-server.mjs';

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
  // 8 memory.* tools + 4 org.* tools. Was 11: `memory.restore` joined the
  // dispatch map, which both stores had always implemented. Bump this with the
  // op named, never loosen it — the count is what catches an op appearing in
  // `tools/list` that nothing can actually dispatch.
  assert.equal(list.result.tools.length, 12);
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

describe('advertise() refuses to serve an op the catalog does not declare', () => {
  test('throws, naming the op and where to declare it', () => {
    // The failure this exists for: a dispatch key with no catalog entry. Left
    // unchecked it is not a crash but something worse — the op is dropped from
    // `tools/list` while `tools/call` keeps serving it, so a client cannot see
    // a capability the server has.
    assert.throws(
      () => advertise({ 'memory.bogus': () => {} }),
      /dispatches "memory\.bogus", which the tool catalog does not declare/,
    );
  });

  test('a fully-declared dispatch map resolves, in catalog order', () => {
    // Anti-vacuity for the case above: the same function must succeed on real
    // input, or the throw could be coming from anywhere.
    const defs = advertise({ 'memory.scopes': () => {}, 'memory.write': () => {} });
    assert.deepEqual(defs.map((d) => d.name), ['memory.write', 'memory.scopes']);
  });
});

test('memory.restore is advertised and undoes a memory.archive', async () => {
  // The archive/restore pair, end to end over stdio. `memory.restore` was
  // absent from this server's dispatch map while `memory.archive` was present,
  // so an agent could hide a lesson through it and had no way to bring it back
  // — even though every store already implemented restore. Asserted as a round-trip
  // rather than by advertisement alone: appearing in `tools/list` is the half
  // that was never the problem.
  const store = tmpDir();
  const home = tmpDir();
  const { messages } = await serve(
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.write', arguments: { scope: 'repo::acme/widget', key: 'k1', value: 'v' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.archive', arguments: { scope: 'repo::acme/widget', key: 'k1' } } },
      // Hidden from a normal read while archived.
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'repo::acme/widget' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory.restore', arguments: { scope: 'repo::acme/widget', key: 'k1' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'memory.list', arguments: { scope: 'repo::acme/widget' } } },
    ],
    { store, home },
  );

  const m = byId(messages);
  assert.ok(
    m.get(1).result.tools.some((t) => t.name === 'memory.restore'),
    'memory.restore is advertised in tools/list',
  );

  const keysAt = (id) => JSON.parse(m.get(id).result.content[0].text).entries.map((e) => e.key);
  assert.deepEqual(keysAt(4), [], 'archived lesson is hidden from a normal list');

  const restored = m.get(5);
  assert.ok(!restored.result.isError, 'restore is not a tool error');
  assert.deepEqual(keysAt(6), ['k1'], 'restore brings the lesson back');
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
      // The shape `RemoteStore.listScopes()` REALLY returns on a non-2xx: the
      // status at the top level, and an `error` carrying `{ message, code }`
      // from `restFetch` — never an `error.httpStatus`.
      [{ ok: false, httpStatus: 403, error: { code: 403, message: 'Forbidden' } }, /HTTP 403/],
      // Tolerance for a store that nests the status instead.
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
    // All counts coerce to 0, so the scope-asc tiebreak decides and the
    // empty-scope row leads.
    assert.deepEqual(out.scopes, [
      { scope: '', count: 0 },
      { scope: 'global', count: 0 },
      { scope: 'x', count: 0 },
    ]);
  });

  test('sorts by count desc then scope asc regardless of the store shape', async () => {
    // The documented contract (docs/mcp-tools.md, the tool catalog, llms.txt).
    // The hosted RPC already orders by count desc then scope asc (00065); the
    // local/two-tier stores return walk order, so the normaliser is what makes
    // the two agree. The counts are chosen so count-desc does NOT coincide with
    // scope-asc (the busiest scope, repo::acme/api, sorts alphabetically last),
    // and global/project::z tie at 2 so the scope-asc tiebreak is exercised too.
    const unsorted = [
      { scope: 'repo::acme/api', count: 5 },
      { scope: 'global', count: 2 },
      { scope: 'branch::acme/api::main', count: 3 },
      { scope: 'project::z', count: 2 },
    ];
    const expected = ['repo::acme/api', 'branch::acme/api::main', 'global', 'project::z'];

    const local = await listScopes({ async listScopes() { return unsorted; } });
    assert.deepEqual(local.scopes.map((s) => s.scope), expected);

    const remote = await listScopes({ async listScopes() { return { ok: true, scopes: unsorted }; } });
    assert.deepEqual(remote.scopes.map((s) => s.scope), expected);
  });

  test('a store with no scopes yields an empty inventory and no note', async () => {
    // Distinct from the failure case above: an empty store is a successful
    // enumeration that found nothing, and must not read as an error.
    const out = await listScopes({ async listScopes() { return []; } });
    assert.deepEqual(out, { ok: true, scopes: [] });
  });
});

// ── memory.list view projection ──────────────────────────────────────────────
// The stdio server mirrors the hosted MCP contract, so `view: "summary"` must
// behave identically here even though the REST route it reads has no such
// parameter — the projection is applied client-side in the dispatcher.

describe('projectListView', () => {
  test('passes a full view through untouched', () => {
    const result = { ok: true, entries: [{ key: 'k', value: 'body', tags: [] }] };
    assert.deepEqual(projectListView(result, 'full'), result);
  });

  test('passes an absent view through untouched', () => {
    const result = { ok: true, entries: [{ key: 'k', value: 'body', tags: [] }] };
    assert.deepEqual(projectListView(result, undefined), result);
  });

  test('omits value and adds value_bytes + preview in summary view', () => {
    const result = { ok: true, entries: [{ key: 'k', value: 'body', tags: ['t'] }] };
    const projected = projectListView(result, 'summary');
    assert.equal('value' in projected.entries[0], false);
    assert.equal(projected.entries[0].value_bytes, 4);
    assert.equal(projected.entries[0].preview, 'body');
    assert.deepEqual(projected.entries[0].tags, ['t']);
  });

  test('reports value_bytes in UTF-8 bytes, not UTF-16 units', () => {
    const result = { ok: true, entries: [{ key: 'k', value: 'é', tags: [] }] };
    assert.equal(projectListView(result, 'summary').entries[0].value_bytes, 2);
  });

  test('never splits a surrogate pair at the preview cap', () => {
    const value = 'x' + '\u{1F600}'.repeat(300);
    const result = { ok: true, entries: [{ key: 'k', value, tags: [] }] };
    const { preview } = projectListView(result, 'summary').entries[0];
    for (const unit of preview) {
      const code = unit.codePointAt(0);
      assert.equal(code >= 0xd800 && code <= 0xdfff, false);
    }
    assert.equal([...preview].length, LIST_PREVIEW_CHARS);
  });

  test('leaves a failed store result alone', () => {
    const failed = { ok: false, error: 'nope' };
    assert.deepEqual(projectListView(failed, 'summary'), failed);
  });
});

describe('memory.list argument validation and taxonomy post-filter', () => {
  const store = (entries) => ({ list: async () => ({ ok: true, entries }) });

  test('rejects an out-of-vocabulary view instead of defaulting to full', async () => {
    await assert.rejects(() => listWithFilters(store([]), { scope: 'global', view: 'sumary' }), /Invalid view/);
  });

  test('rejects an out-of-vocabulary kind', async () => {
    await assert.rejects(() => listWithFilters(store([]), { scope: 'global', kind: 'lessons' }), /Invalid kind/);
  });

  test('rejects an empty host', async () => {
    await assert.rejects(() => listWithFilters(store([]), { scope: 'global', host: '' }), /Invalid host/);
  });

  test('accepts the documented vocabulary', async () => {
    const r = await listWithFilters(store([]), { scope: 'global', view: 'summary', kind: 'lesson', host: 'reviewer' });
    assert.equal(r.ok, true);
  });

  test('post-filters local rows by host inferred from the loop:: tag', async () => {
    // Local rows carry no kind/host columns — without the post-filter the whole
    // scope comes back and looks narrowed.
    const entries = [
      { key: 'a', value: 'x', tags: ['loop::reviewer-lessons'] },
      { key: 'b', value: 'y', tags: ['loop::aw-lessons'] },
    ];
    const r = await listWithFilters(store(entries), { scope: 'global', host: 'reviewer' });
    assert.deepEqual(r.entries.map((e) => e.key), ['a']);
  });

  test('post-filters by kind inferred from the loop:: tag', async () => {
    const entries = [
      { key: 'a', value: 'x', tags: ['loop::reviewer-comment-relevance'] },
      { key: 'b', value: 'y', tags: ['loop::aw-lessons'] },
    ];
    const r = await listWithFilters(store(entries), { scope: 'global', kind: 'signal' });
    assert.deepEqual(r.entries.map((e) => e.key), ['a']);
  });

  test('prefers an explicit column over the inferred tag', async () => {
    const entries = [{ key: 'a', value: 'x', tags: ['loop::aw-lessons'], host: 'reviewer' }];
    const r = await listWithFilters(store(entries), { scope: 'global', host: 'reviewer' });
    assert.equal(r.entries.length, 1);
  });

  test('leaves the result untouched when neither filter is given', async () => {
    const entries = [{ key: 'a', value: 'x', tags: [] }];
    const r = await listWithFilters(store(entries), { scope: 'global' });
    assert.deepEqual(r.entries, entries);
  });
});

describe('memory.list over-fetches before post-filtering', () => {
  // The stores slice to `limit` before this module can post-filter, so a naive
  // implementation returns an empty page when the first `limit` rows all belong
  // to a different bucket — a silently empty read that reads as "none exist".
  const rows = (n, tag, prefix) =>
    Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, value: 'x', tags: [tag] }));

  // Honours `limit` the way LocalStore does: slice AFTER tag filtering, before
  // returning. Records the limit it was asked for so the over-fetch is visible.
  const slicingStore = (all) => {
    const seen = {};
    return {
      seen,
      list: async ({ limit }) => {
        seen.limit = limit;
        return { ok: true, entries: limit ? all.slice(0, limit) : all };
      },
    };
  };

  test('finds rows that sit beyond the requested limit', async () => {
    const all = [...rows(5, 'loop::aw-lessons', 'aw'), ...rows(5, 'loop::reviewer-lessons', 'rv')];
    const store = slicingStore(all);
    const r = await listWithFilters(store, { scope: 'global', limit: 5, host: 'reviewer' });
    assert.equal(r.entries.length, 5);
    assert.deepEqual(r.entries.map((e) => e.key), ['rv0', 'rv1', 'rv2', 'rv3', 'rv4']);
  });

  test('widens the fetch it asks the store for', async () => {
    const store = slicingStore(rows(10, 'loop::reviewer-lessons', 'rv'));
    await listWithFilters(store, { scope: 'global', limit: 5, host: 'reviewer' });
    assert.ok(store.seen.limit > 5, `expected an over-fetch, got limit=${store.seen.limit}`);
  });

  test('still honours the requested limit after filtering', async () => {
    const store = slicingStore(rows(40, 'loop::reviewer-lessons', 'rv'));
    const r = await listWithFilters(store, { scope: 'global', limit: 3, host: 'reviewer' });
    assert.equal(r.entries.length, 3);
    assert.equal(r.hasMore, true);
  });

  test('reports hasMore false when the filtered set fits the page', async () => {
    const store = slicingStore(rows(2, 'loop::reviewer-lessons', 'rv'));
    const r = await listWithFilters(store, { scope: 'global', limit: 10, host: 'reviewer' });
    assert.equal(r.entries.length, 2);
    assert.equal(r.hasMore, false);
  });

  test('does not widen the fetch when no taxonomy filter is given', async () => {
    const store = slicingStore(rows(10, 'loop::reviewer-lessons', 'rv'));
    await listWithFilters(store, { scope: 'global', limit: 5 });
    assert.equal(store.seen.limit, 5);
  });
});

describe('memory.list taxonomy filter respects the remote limit cap and cursor contract', () => {
  const rows = (n, tag, prefix) =>
    Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, value: 'x', tags: [tag] }));

  test('never asks the store for more than the route cap of 100', async () => {
    // ListMemoriesQuerySchema caps GET /memories limit at 100; a widened fetch
    // above that is a 400 from RemoteStore, not a bigger page.
    const seen = {};
    const store = { list: async ({ limit }) => { seen.limit = limit; return { ok: true, entries: [] }; } };
    await listWithFilters(store, { scope: 'global', limit: 50, host: 'reviewer' });
    assert.ok(seen.limit <= 100, `widened to ${seen.limit}, above the route cap`);
  });

  test('caps the widened fetch even at the maximum requested limit', async () => {
    const seen = {};
    const store = { list: async ({ limit }) => { seen.limit = limit; return { ok: true, entries: [] }; } };
    await listWithFilters(store, { scope: 'global', limit: 100, host: 'reviewer' });
    assert.ok(seen.limit <= 100, `widened to ${seen.limit}, above the route cap`);
  });

  test('returns nextCursor null rather than the upstream cursor', async () => {
    // The upstream cursor is a keyset position in the UNFILTERED order taken
    // from the end of the widened fetch — resuming from it would skip every row
    // between the slice and the widened window.
    const store = {
      list: async () => ({
        ok: true,
        entries: rows(40, 'loop::reviewer-lessons', 'rv'),
        hasMore: true,
        nextCursor: 'UPSTREAM_CURSOR',
      }),
    };
    const r = await listWithFilters(store, { scope: 'global', limit: 5, host: 'reviewer' });
    assert.equal(r.nextCursor, null);
    assert.equal(r.hasMore, true);
    assert.equal(r.entries.length, 5);
  });

  test('leaves the cursor untouched on an unfiltered read', async () => {
    const store = {
      list: async () => ({ ok: true, entries: rows(2, 'loop::reviewer-lessons', 'rv'), hasMore: true, nextCursor: 'C' }),
    };
    const r = await listWithFilters(store, { scope: 'global', limit: 5 });
    assert.equal(r.nextCursor, 'C');
  });
});

describe('memory.list ignores an inbound cursor when a taxonomy filter is set', () => {
  test('does not forward cursor to the store', async () => {
    // A cursor is a keyset position in the UNFILTERED order; honouring it inside
    // a client-side-filtered read resumes mid-way through a sequence this call
    // never produced. The tool schema promises it is ignored.
    const seen = {};
    const store = { list: async (args) => { Object.assign(seen, args); return { ok: true, entries: [] }; } };
    await listWithFilters(store, { scope: 'global', host: 'reviewer', cursor: 'ABC' });
    assert.equal(seen.cursor, undefined);
  });

  test('still forwards cursor on an unfiltered read', async () => {
    const seen = {};
    const store = { list: async (args) => { Object.assign(seen, args); return { ok: true, entries: [] }; } };
    await listWithFilters(store, { scope: 'global', cursor: 'ABC' });
    assert.equal(seen.cursor, 'ABC');
  });
});
