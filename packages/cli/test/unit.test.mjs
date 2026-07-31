import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerRepoFromRemote } from '../src/scope.mjs';
import { splitEndpoint, buildRemoteUrl, mcpCall } from '../src/mcp.mjs';
import { tokenKind } from '../src/config.mjs';
import { parseArgs, selectAction, select } from '../src/util.mjs';
import { createRemoteStore } from '../src/store/remote.mjs';

test('ownerRepoFromRemote normalizes remote URL variants', () => {
  assert.equal(ownerRepoFromRemote('git@github.com:mthines/LoreKit.git'), 'mthines/lorekit');
  assert.equal(ownerRepoFromRemote('https://github.com/mthines/lorekit.git'), 'mthines/lorekit');
  assert.equal(ownerRepoFromRemote('https://github.com/mthines/lorekit'), 'mthines/lorekit');
  assert.equal(ownerRepoFromRemote('ssh://git@github.com/mthines/lorekit.git'), 'mthines/lorekit');
  assert.equal(ownerRepoFromRemote(''), null);
  assert.equal(ownerRepoFromRemote('not-a-url'), null);
});

test('splitEndpoint pulls the token out of the query string', () => {
  const { endpoint, token } = splitEndpoint('https://ref.supabase.co/functions/v1/mcp?token=lk_rw_abc');
  assert.equal(endpoint, 'https://ref.supabase.co/functions/v1/mcp');
  assert.equal(token, 'lk_rw_abc');
});

test('splitEndpoint tolerates a URL with no token', () => {
  const { endpoint, token } = splitEndpoint('https://ref.supabase.co/functions/v1/mcp');
  assert.equal(endpoint, 'https://ref.supabase.co/functions/v1/mcp');
  assert.equal(token, null);
});

test('buildRemoteUrl round-trips with splitEndpoint', () => {
  const url = buildRemoteUrl('https://ref.supabase.co/functions/v1/mcp', 'lk_ro_xyz');
  assert.equal(splitEndpoint(url).token, 'lk_ro_xyz');
});

// ── mcpCall traceparent propagation ───────────────────────────────────────────
// Without this the MCP-only operations (the four org.*) start a fresh,
// uncorrelated server-side trace.

async function captureMcpFetch(opts) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, headers: init.headers };
    return { ok: true, status: 200, statusText: 'OK', async text() { return '{"jsonrpc":"2.0","id":1,"result":{}}'; } };
  };
  try {
    await mcpCall('https://ref.supabase.co/functions/v1/mcp', 'lk_rw_abc', 'tools/list', {}, opts);
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

test('mcpCall sends the traceparent header when given one', async () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const captured = await captureMcpFetch({ traceparent: tp });
  assert.equal(captured.headers.traceparent, tp);
});

test('mcpCall omits the traceparent header when not given one', async () => {
  const captured = await captureMcpFetch({});
  assert.ok(!('traceparent' in captured.headers));
  const noOpts = await captureMcpFetch(undefined);
  assert.ok(!('traceparent' in noOpts.headers));
});

test('tokenKind classifies by prefix', () => {
  assert.equal(tokenKind('lk_rw_abc'), 'read-write');
  assert.equal(tokenKind('lk_ro_abc'), 'read-only');
  assert.equal(tokenKind('lk_wo_abc'), 'write-only');
  assert.equal(tokenKind('sbp_xyz'), 'unknown');
  assert.equal(tokenKind(null), 'none');
});

test('parseArgs handles flags, values, =, and aliases', () => {
  const args = parseArgs(['install', '-e', 'https://x', '--token=lk_rw_1', '--yes'], {
    aliases: { e: 'endpoint', t: 'token' },
    booleans: ['yes'],
  });
  assert.equal(args._[0], 'install');
  assert.equal(args.endpoint, 'https://x');
  assert.equal(args.token, 'lk_rw_1');
  assert.equal(args.yes, true);
});

test('parseArgs collects unknown flags when a known list is given', () => {
  const args = parseArgs(['doctor', '--gloabl', '--mode', 'off', '-x'], {
    aliases: { d: 'dir' },
    booleans: ['global'],
    known: ['dir', 'global', 'mode'],
  });
  assert.deepEqual(args._unknown, ['--gloabl', '-x']);
  assert.equal(args.mode, 'off'); // known flags still parse normally
});

test('parseArgs reports no unknowns when every flag is recognized', () => {
  const args = parseArgs(['install', '--global', '--yes'], {
    booleans: ['global', 'yes'],
    known: ['global', 'yes'],
  });
  assert.deepEqual(args._unknown, []);
});

test('parseArgs resolves an alias before the unknown check', () => {
  // -d is an alias for the known `dir`, so it must not be flagged as unknown.
  const args = parseArgs(['doctor', '-d', '/tmp'], {
    aliases: { d: 'dir' },
    known: ['dir'],
  });
  assert.deepEqual(args._unknown, []);
  assert.equal(args.dir, '/tmp');
});

test('parseArgs omits _unknown entirely when no known list is given', () => {
  const args = parseArgs(['doctor', '--whatever'], {});
  assert.equal(args._unknown, undefined);
});

test('selectAction maps keys to list actions', () => {
  assert.equal(selectAction(''), 'cancel'); // Ctrl-C
  assert.equal(selectAction('\r'), 'submit');
  assert.equal(selectAction('\n'), 'submit');
  assert.equal(selectAction('[A'), 'up'); // arrow-up (ESC [ cursor mode)
  assert.equal(selectAction('OA'), 'up'); // arrow-up (ESC O application mode)
  assert.equal(selectAction('[B'), 'down');
  assert.equal(selectAction('OB'), 'down');
  assert.equal(selectAction('k'), 'up');
  assert.equal(selectAction('j'), 'down');
  assert.equal(selectAction('x'), null);
});

test('select resolves the default option when stdin is not a TTY', async () => {
  const wasTTY = process.stdin.isTTY;
  process.stdin.isTTY = false; // simulate piped / CI stdin
  try {
    const value = await select('pick', [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ], { defaultIndex: 1 });
    assert.equal(value, 'b');
  } finally {
    process.stdin.isTTY = wasTTY;
  }
});

// ── RemoteStore: EVERY memory operation goes over REST ────────────────────────
// The store used to fall back to the MCP endpoint for the hard-delete branch
// (`memory.delete` with `force: true`) and had no remote scope enumeration at
// all. Both are REST routes now, so these assert on the ACTUAL URL issued —
// a wrong path fails only at runtime against a live backend otherwise.

const REMOTE_MCP_URL = 'https://ref.supabase.co/functions/v1/mcp';
const REMOTE_REST_BASE = 'https://ref.supabase.co/functions/v1';

// Run `fn(store)` with a stubbed global fetch, capturing every request. The
// stub answers with `status`/`body`; `throws` simulates a transport failure.
async function captureRestCalls(fn, { status = 200, body = '{}', throws = null } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (throws) throw new Error(throws);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Mock',
      async text() { return body; },
    };
  };
  try {
    const result = await fn(createRemoteStore({ endpoint: REMOTE_MCP_URL, token: 'lk_rw_abc' }));
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('delete({force:true}) hard-deletes over REST, never the MCP endpoint', async () => {
  const { result, calls } = await captureRestCalls(
    (store) => store.delete({ scope: 'global', key: 'k', force: true }),
    { status: 204, body: '' },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/memories?scope=global&key=k&force=true`);
  // The MCP JSON-RPC endpoint must not be touched at all.
  assert.ok(!calls.some((c) => c.url.endsWith('/mcp')));
});

test('delete({force:false}) soft-archives and never sends force=true', async () => {
  const { result, calls } = await captureRestCalls(
    (store) => store.delete({ scope: 'global', key: 'k' }),
    { status: 204, body: '' },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/memories?scope=global&key=k`);
  assert.ok(!calls[0].url.includes('force'));
});

test('archive() is the soft-archive DELETE — no force=true', async () => {
  const { calls } = await captureRestCalls(
    (store) => store.archive({ scope: 'repo::acme/api', key: 'k' }),
    { status: 204, body: '' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.ok(!calls[0].url.includes('force'));
  // scope/key are query-encoded, so `::` and `/` survive the round-trip.
  assert.equal(
    new URL(calls[0].url).searchParams.get('scope'),
    'repo::acme/api',
  );
});

test('listScopes() maps GET /memories/scopes into the inventory contract', async () => {
  const { result, calls } = await captureRestCalls((store) => store.listScopes(), {
    status: 200,
    body: JSON.stringify({ scopes: [{ scope: 'global', count: 2 }, { scope: 'repo::acme/api', count: 4 }] }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/memories/scopes`);
  assert.equal(result.ok, true);
  // The SAME `[{ scope, count }]` shape `LocalStore.listScopes()` returns, so
  // `scopes.mjs` feeds both through filterScopeInventory/summarizeScopeInventory.
  assert.deepEqual(result.scopes, [
    { scope: 'global', count: 2 },
    { scope: 'repo::acme/api', count: 4 },
  ]);
});

test('listScopes() tolerates a response with no scopes array', async () => {
  const { result } = await captureRestCalls((store) => store.listScopes(), {
    status: 200,
    body: '{}',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, []);
});

test('listScopes() degrades gracefully on a network error', async () => {
  const { result } = await captureRestCalls((store) => store.listScopes(), {
    throws: 'ECONNREFUSED',
  });
  assert.equal(result.ok, false);
  assert.match(String(result.networkError), /ECONNREFUSED/);
  assert.equal(result.scopes, undefined);
});

test('listScopes() degrades gracefully on a non-2xx', async () => {
  const { result } = await captureRestCalls((store) => store.listScopes(), {
    status: 500,
    body: 'boom',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 500);
  assert.equal(result.networkError, undefined);
});

test('listScopes() on an unusable store never calls fetch', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  try {
    const res = await createRemoteStore({ endpoint: null, token: null }).listScopes();
    assert.equal(res.ok, false);
    assert.equal(res.unusable, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
