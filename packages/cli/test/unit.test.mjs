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
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      // `undefined` when the request carried no body at all — distinguishable
      // from an empty one, which matters for the DELETE assertions.
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
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

// ── RemoteStore: the four org.* operations go over REST too ───────────────────
// This is the last transport the store held on MCP. `supabase/functions/orgs/`
// serves `lk_*` tokens on every route as of 00041_org_actor_override.sql, so
// there is nothing left to route through JSON-RPC.
//
// Each test asserts the exact URL, method and body, AND that `/mcp` is never
// touched — a regression to `_mcp(...)` would otherwise still "work" against a
// live backend and only show up as a lost trace and a different error shape.
// The return SHAPES are asserted deliberately: `mcp-server.mjs` serialises them
// straight into a `tools/call` result, so they are a published contract.

/** Every org method must leave the JSON-RPC endpoint completely untouched. */
function assertNoMcp(calls) {
  const offenders = calls.filter((c) => c.url.includes('/functions/v1/mcp'));
  assert.deepEqual(offenders, [], `org op hit the MCP endpoint: ${JSON.stringify(offenders)}`);
}

test('orgCreate() POSTs /orgs and rebuilds the { id, slug, name } contract', async () => {
  const { result, calls } = await captureRestCalls(
    (store) => store.orgCreate({ slug: 'acme', name: 'Acme Inc' }),
    { status: 201, body: JSON.stringify('org-uuid-1') },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/orgs`);
  assert.deepEqual(calls[0].body, { slug: 'acme', name: 'Acme Inc' });
  assertNoMcp(calls);
  // POST /orgs answers with the bare id; slug/name came from the caller.
  assert.deepEqual(result, { ok: true, org: { id: 'org-uuid-1', slug: 'acme', name: 'Acme Inc' } });
});

test('orgList() GETs /orgs and returns { entries }', async () => {
  const entries = [{ id: 'i', slug: 'acme', name: 'Acme Inc', role: 'owner', created_at: 't' }];
  const { result, calls } = await captureRestCalls((store) => store.orgList(), {
    status: 200,
    body: JSON.stringify({ entries }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/orgs`);
  assert.equal(calls[0].body, undefined);
  assertNoMcp(calls);
  assert.deepEqual(result, { ok: true, entries });
});

test('orgList() returns an empty list when the response has no entries array', async () => {
  const { result } = await captureRestCalls((store) => store.orgList(), { status: 200, body: '{}' });
  assert.deepEqual(result, { ok: true, entries: [] });
});

test('orgRename() PATCHes /orgs/:slug with only the new name in the body', async () => {
  const { result, calls } = await captureRestCalls(
    (store) => store.orgRename({ slug: 'acme', name: 'Acme Corp' }),
    { status: 200, body: JSON.stringify({ slug: 'acme', name: 'Acme Corp' }) },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/orgs/acme`);
  // The slug is in the path, so it must NOT also be in the body.
  assert.deepEqual(calls[0].body, { name: 'Acme Corp' });
  assertNoMcp(calls);
  assert.deepEqual(result, { ok: true, slug: 'acme', name: 'Acme Corp' });
});

test('orgDelete() DELETEs /orgs/:slug and synthesises deleted:true from the 204', async () => {
  const { result, calls } = await captureRestCalls((store) => store.orgDelete({ slug: 'acme' }), {
    status: 204,
    body: '',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/orgs/acme`);
  assert.equal(calls[0].body, undefined);
  assertNoMcp(calls);
  // 204 carries no body — the MCP tool returned { deleted: true, slug }, so the
  // store reconstructs it rather than changing the contract.
  assert.deepEqual(result, { ok: true, deleted: true, slug: 'acme' });
});

// Slugs are PATH segments now, not JSON-RPC arguments. An un-encoded `/` or `?`
// would silently retarget the request at a different route.
test('org slugs are URL-encoded into the path', async () => {
  const nasty = 'a/b?c=d e#f';
  const encoded = encodeURIComponent(nasty);
  for (const [label, call] of [
    ['orgRename', (store) => store.orgRename({ slug: nasty, name: 'N' })],
    ['orgDelete', (store) => store.orgDelete({ slug: nasty })],
  ]) {
    const { calls } = await captureRestCalls(call, { status: 200, body: '{}' });
    assert.equal(calls[0].url, `${REMOTE_REST_BASE}/orgs/${encoded}`, label);
    // No raw separator leaked into the path.
    assert.ok(!calls[0].url.slice(`${REMOTE_REST_BASE}/orgs/`.length).includes('/'), `${label}: unescaped /`);
    assert.ok(!calls[0].url.includes('?'), `${label}: unescaped ?`);
    assert.ok(!calls[0].url.includes('#'), `${label}: unescaped #`);
  }
});

// ── Org ops degrade like every other store method ─────────────────────────────

test('org ops degrade gracefully on a network failure', async () => {
  for (const [label, call] of [
    ['orgCreate', (store) => store.orgCreate({ slug: 'acme', name: 'A' })],
    ['orgList', (store) => store.orgList()],
    ['orgRename', (store) => store.orgRename({ slug: 'acme', name: 'A' })],
    ['orgDelete', (store) => store.orgDelete({ slug: 'acme' })],
  ]) {
    const { result } = await captureRestCalls(call, { throws: 'ECONNREFUSED' });
    assert.equal(result.ok, false, label);
    assert.match(String(result.networkError), /ECONNREFUSED/, label);
    // No half-populated success payload leaks out alongside the failure.
    assert.equal(result.org, undefined, label);
    assert.equal(result.entries, undefined, label);
    assert.equal(result.deleted, undefined, label);
  }
});

test('org ops degrade gracefully on a non-2xx (403 from an under-privileged role)', async () => {
  for (const [label, call] of [
    ['orgCreate', (store) => store.orgCreate({ slug: 'acme', name: 'A' })],
    ['orgList', (store) => store.orgList()],
    ['orgRename', (store) => store.orgRename({ slug: 'acme', name: 'A' })],
    ['orgDelete', (store) => store.orgDelete({ slug: 'acme' })],
  ]) {
    const { result } = await captureRestCalls(call, {
      status: 403,
      body: JSON.stringify({ error: 'Insufficient permissions for this org action.', code: 'org_permission_denied' }),
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'org_permission_denied', label);
    assert.match(result.error.message, /Insufficient permissions/, label);
    assert.equal(result.networkError, undefined, label);
  }
});

test('org ops on an unusable store never call fetch', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  try {
    const store = createRemoteStore({ endpoint: null, token: null });
    for (const res of [
      await store.orgCreate({ slug: 'a', name: 'A' }),
      await store.orgList(),
      await store.orgRename({ slug: 'a', name: 'A' }),
      await store.orgDelete({ slug: 'a' }),
    ]) {
      assert.equal(res.ok, false);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

// ── verifyAuth(): the probe that actually judges the TOKEN ───────────────────
//
// `ping()` hits the PUBLIC /health function, so it is green for a revoked token
// — which is exactly how doctor came to report "connectivity — reachable" while
// every remote read answered "Authentication required". verifyAuth is the
// authenticated half; these tests pin its classification, because each status
// means something different to a user and collapsing them is the original bug
// in a new shape.

test('verifyAuth() makes ONE authenticated, side-effect-free GET', async () => {
  const { result, calls } = await captureRestCalls((store) => store.verifyAuth(), {
    status: 200,
    body: '{"entries":[]}',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/memories?limit=1`);
  assert.equal(calls[0].body, undefined, 'the probe must not send a body');
  assertNoMcp(calls);
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.permitted, true);
});

test('verifyAuth() reports a 401 as NOT authenticated (the revoked-token case)', async () => {
  const { result } = await captureRestCalls((store) => store.verifyAuth(), {
    status: 401,
    body: '{"error":"Authentication required","code":"unauthorized"}',
  });
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.httpStatus, 401);
});

test('verifyAuth() reports a 403 as authenticated but unpermitted (a healthy lk_wo_ token)', async () => {
  const { result } = await captureRestCalls((store) => store.verifyAuth(), {
    status: 403,
    body: '{"error":"Read permission required","code":"forbidden"}',
  });
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.permitted, false);
});

// `GET /memories` has no rate-limit check (the only `tooManyRequests()` call
// sites are the create/purge write paths), so a 429 on this probe comes from the
// platform edge BEFORE `resolveRestAuth` — it cannot vouch for the token.
test('verifyAuth() leaves the verdict UNKNOWN on a 429 — it never reached auth', async () => {
  const { result } = await captureRestCalls((store) => store.verifyAuth(), {
    status: 429,
    body: '{"error":"Too many requests","code":"rate_limited"}',
  });
  assert.equal(result.authenticated, null, 'a 429 says nothing about the credential');
  assert.equal(result.rateLimited, true, 'still flagged so doctor can say "retry shortly"');
  assert.equal(result.ok, true, 'the probe itself completed; doctor branches on rateLimited first');
});

test('verifyAuth() leaves the verdict UNKNOWN on a server error, never "revoked"', async () => {
  const { result } = await captureRestCalls((store) => store.verifyAuth(), { status: 500, body: 'boom' });
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, null, 'a 500 says nothing about the credential');
});

test('verifyAuth() leaves the verdict UNKNOWN on a network error', async () => {
  const { result } = await captureRestCalls((store) => store.verifyAuth(), { throws: 'ECONNREFUSED' });
  assert.equal(result.authenticated, null);
  assert.match(String(result.networkError), /ECONNREFUSED/);
});

test('verifyAuth() on an unusable store never calls fetch', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  try {
    const res = await createRemoteStore({ endpoint: null, token: null }).verifyAuth();
    assert.equal(res.ok, false);
    assert.equal(res.unusable, true);
    assert.equal(res.authenticated, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

// ── ping() no longer falls back to the MCP endpoint ───────────────────────────

test('ping() probes /health and never the MCP endpoint', async () => {
  const { result, calls } = await captureRestCalls((store) => store.ping(), { status: 200, body: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ref.supabase.co/functions/v1/health');
  assertNoMcp(calls);
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
});

test('ping() reports an unparseable endpoint instead of falling back to JSON-RPC', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  try {
    // `usable()` passes (endpoint + token are set) but mcpToRestBase() cannot
    // parse it, so restBase is null — the old code POSTed JSON-RPC at it.
    const res = await createRemoteStore({ endpoint: 'not-a-url', token: 'lk_rw_abc' }).ping();
    assert.equal(res.ok, false);
    assert.match(res.error.message, /not a valid URL/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
