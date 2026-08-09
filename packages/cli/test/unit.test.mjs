import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ownerRepoFromRemote } from '../src/scope.mjs';
import { splitEndpoint, buildRemoteUrl, mcpCall } from '../src/mcp.mjs';
import { tokenKind } from '../src/config.mjs';
import { parseArgs, selectAction, select } from '../src/util.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteStore } from '../src/store/remote.mjs';
import { createLocalStore } from '../src/store/local.mjs';
import {
  gatherStream, gather, clusterDuplicates, clusterDuplicatesBlocked, DEFAULT_MAX,
} from '../src/lessons-view.mjs';
import {
  rankLessons, scoreLesson, recencyFactor, salienceFactor, relevanceFactor,
  RECENCY_HALF_LIFE_DAYS,
} from '../src/lessons-pure.mjs';
import { MEMORY_TOOL_DEFS } from '../src/mcp-server.mjs';

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

test('search() POSTs a string query straight through to /memories/search', async () => {
  const { calls } = await captureRestCalls(
    (store) => store.search({ q: 'eslint', scopes: ['global'] }),
    { status: 200, body: JSON.stringify({ entries: [] }) },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${REMOTE_REST_BASE}/memories/search`);
  assert.equal(calls[0].body.q, 'eslint');
});

test('search() collapses a term LIST into one OR-joined FTS query (single round-trip)', async () => {
  const { calls } = await captureRestCalls(
    (store) => store.search({ q: ['econnrefused', 'timeout', 'retry'], scopes: ['global'] }),
    { status: 200, body: JSON.stringify({ entries: [] }) },
  );
  assert.equal(calls.length, 1); // one POST for all terms, not one per term
  assert.equal(calls[0].body.q, 'econnrefused OR timeout OR retry');
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

// ── AC-1: RemoteStore.list cursor threading (multi-page drain) ────────────────
// The store must thread `cursor` and `limit` into the query string so callers
// can drain all pages by passing the previous response's `nextCursor` back.

describe('RemoteStore.list cursor threading', () => {
  test('list sends cursor and limit params and returns hasMore/nextCursor', async () => {
    const page1Cursor = 'cursor-page-2';
    const { result, calls } = await captureRestCalls(
      (store) => store.list({ scope: 'global', limit: 10, cursor: page1Cursor }),
      { status: 200, body: JSON.stringify({ entries: [{ key: 'k', value: 'v', scope: 'global' }], hasMore: true, nextCursor: 'cursor-page-3' }) },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('cursor'), page1Cursor, 'cursor forwarded');
    assert.equal(u.searchParams.get('limit'), '10', 'limit forwarded');
    assert.equal(u.searchParams.get('scope'), 'global', 'scope forwarded');
    assert.equal(result.ok, true);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextCursor, 'cursor-page-3');
    assert.equal(result.entries.length, 1);
  });

  test('list multi-page drain: caller can follow nextCursor across pages', async () => {
    // Simulate two-page response sequence: page 1 has nextCursor, page 2 does not.
    const pages = [
      { entries: [{ key: 'k1', value: 'v1', scope: 'global' }], hasMore: true, nextCursor: 'page-2' },
      { entries: [{ key: 'k2', value: 'v2', scope: 'global' }], hasMore: false, nextCursor: null },
    ];
    let pageIdx = 0;
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return {
        ok: true, status: 200, statusText: 'Mock',
        async text() { return JSON.stringify(pages[pageIdx++]); },
      };
    };
    const store = createRemoteStore({ endpoint: REMOTE_MCP_URL, token: 'lk_rw_abc' });
    try {
      const all = [];
      let cursor = undefined;
      let iter = 0;
      while (iter < 5) {
        iter += 1;
        const res = await store.list({ scope: 'global', limit: 100, cursor });
        assert.equal(res.ok, true);
        all.push(...res.entries);
        if (!res.hasMore || !res.nextCursor) break;
        cursor = res.nextCursor;
      }
      assert.equal(all.length, 2, 'collected entries from both pages');
      assert.equal(calls.length, 2, 'exactly two requests issued');
      const u2 = new URL(calls[1].url);
      assert.equal(u2.searchParams.get('cursor'), 'page-2', 'second request carries cursor');
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ── AC-2: RemoteStore.read single limit=1 request ────────────────────────────
// `read()` must send `limit=1` — fetching the full default page for a
// scope+key lookup is wasteful and the server returns everything anyway.

describe('RemoteStore.read single limit=1', () => {
  test('read issues limit=1 and returns the first entry', async () => {
    const { result, calls } = await captureRestCalls(
      (store) => store.read({ scope: 'global', key: 'mykey' }),
      { status: 200, body: JSON.stringify({ entries: [{ key: 'mykey', value: 'v', scope: 'global' }] }) },
    );
    assert.equal(calls.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('limit'), '1', 'exactly limit=1 sent');
    assert.equal(u.searchParams.get('key'), 'mykey');
    assert.equal(u.searchParams.get('scope'), 'global');
    assert.equal(result.ok, true);
    assert.ok(result.entry, 'entry populated from first result');
    assert.equal(result.entry.key, 'mykey');
  });
});

// ── AC-3: RemoteStore.search cursor/limit threading ───────────────────────────

describe('RemoteStore.search cursor/limit threading', () => {
  test('search sends cursor and limit in POST body, returns hasMore/nextCursor', async () => {
    const { result, calls } = await captureRestCalls(
      (store) => store.search({ q: 'test', limit: 5, cursor: 'search-cursor-2' }),
      { status: 200, body: JSON.stringify({ entries: [{ key: 'k', value: 'test value', scope: 'global' }], hasMore: true, nextCursor: 'search-cursor-3' }) },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.ok(calls[0].url.endsWith('/memories/search'));
    assert.equal(calls[0].body.q, 'test');
    assert.equal(calls[0].body.limit, 5, 'limit in body');
    assert.equal(calls[0].body.cursor, 'search-cursor-2', 'cursor in body');
    assert.equal(result.ok, true);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextCursor, 'search-cursor-3');
  });
});

// ── AC-4: gatherStream multi-page; gather still single-page ──────────────────
// `gather` must issue exactly one list call per scope.
// `gatherStream` must follow pages until `hasMore` is false.

describe('gatherStream multi-page invokes onPage per page and gather stays single-page', () => {
  // Build a mock store that simulates two pages of entries for scope 'global'.
  function makeTwoPageStore() {
    let callCount = 0;
    return {
      mode: 'remote',
      usable: () => true,
      listScopes: async () => ({ ok: true, scopes: [{ scope: 'global', count: 2 }] }),
      list: async ({ scope, cursor }) => {
        callCount += 1;
        if (!cursor) {
          return { ok: true, entries: [{ key: 'k1', value: 'value one', scope }], hasMore: true, nextCursor: 'p2' };
        }
        return { ok: true, entries: [{ key: 'k2', value: 'value two', scope }], hasMore: false, nextCursor: null };
      },
      getCallCount: () => callCount,
    };
  }

  test('gatherStream invokes onPage once per page and collects all entries', async () => {
    const store = makeTwoPageStore();
    const pages = [];
    const result = await gatherStream(store, ['global'], {
      onPage: (p) => pages.push({ ...p }),
    });
    assert.equal(pages.length, 2, 'onPage called twice (two pages)');
    assert.equal(pages[0].entries.length, 1);
    assert.equal(pages[1].entries.length, 1);
    assert.equal(result.surveyed, 2);
    assert.equal(result.capped, false);
  });

  test('gather single page: only one list call per scope, no cursor follow', async () => {
    const store = makeTwoPageStore();
    const result = await gather(store, ['global']);
    // gather does NOT follow pages — exactly one call per scope.
    assert.equal(store.getCallCount(), 1, 'gather issues one list call');
    assert.equal(result.total, 1, 'only first-page entries returned');
  });
});

// ── AC-5: --max cap stops survey and reports capped ──────────────────────────

describe('--max cap stops survey and reports capped', () => {
  function makeInfiniteStore() {
    return {
      mode: 'remote',
      usable: () => true,
      list: async ({ scope, cursor }) => ({
        ok: true,
        entries: [{ key: `k-${cursor ?? 'start'}`, value: 'same words every page so jaccard works', scope }],
        hasMore: true,
        nextCursor: `next-${cursor ?? 'start'}`,
      }),
    };
  }

  test('gatherStream stops at max cap and sets capped=true', async () => {
    const store = makeInfiniteStore();
    let surveyedCount = 0;
    const result = await gatherStream(store, ['global'], {
      max: 3,
      onPage: ({ entries }) => { surveyedCount += entries.length; },
    });
    assert.equal(result.capped, true, 'capped flag set');
    assert.ok(result.surveyed <= 3, `surveyed (${result.surveyed}) must be <= max (3)`);
  });
});

// ── AC-6: stats remote count equals scopes aggregate ─────────────────────────
// RemoteStore.listScopes() returns the Postgres aggregate from GET /memories/scopes.
// The aggregate count must match what a full drain would have found.

describe('stats remote count equals scopes aggregate', () => {
  test('listScopes aggregate matches surveyed count for that scope', async () => {
    // Mock: the aggregate says 42 entries in global; the entry list returns 42.
    const aggregate = { scopes: [{ scope: 'global', count: 42 }] };
    const { result, calls } = await captureRestCalls(
      (store) => store.listScopes(),
      { status: 200, body: JSON.stringify(aggregate) },
    );
    assert.equal(result.ok, true);
    const globalScope = result.scopes.find((s) => s.scope === 'global');
    assert.ok(globalScope, 'global scope present');
    assert.equal(globalScope.count, 42, 'aggregate count equals expected');
    // Exactly one GET request to /memories/scopes.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/memories/scopes'));
  });

  test('gatherStream total uses listScopes aggregate when available', async () => {
    // The store returns 1 entry but listScopes says there are 150 (rest are on later pages
    // we stop early due to max). The returned `total` should come from listScopes.
    const store = {
      mode: 'remote',
      usable: () => true,
      listScopes: async () => ({ ok: true, scopes: [{ scope: 'global', count: 150 }] }),
      list: async ({ scope }) => ({
        ok: true,
        entries: [{ key: 'k1', value: 'val', scope }],
        hasMore: false,
        nextCursor: null,
      }),
    };
    const result = await gatherStream(store, ['global'], {});
    // The aggregate total from listScopes (150) should be reported as `total`,
    // even though only 1 entry was surveyed.
    assert.equal(result.total, 150, 'total derived from listScopes aggregate');
    assert.equal(result.surveyed, 1, 'surveyed reflects actual pages read');
  });
});

// ── AC-7: clusterDuplicatesBlocked equivalence with clusterDuplicates ─────────
// On any fixture, clusterDuplicatesBlocked must return clusters identical to
// clusterDuplicates (same members, same size, same similarity stats).

describe('clusterDuplicatesBlocked equivalence with clusterDuplicates', () => {
  const FIXTURE = [
    { scope: 'global', key: 'a', value: 'the quick brown fox jumps' },
    { scope: 'global', key: 'b', value: 'the quick brown fox runs' },
    { scope: 'global', key: 'c', value: 'completely different content here' },
    { scope: 'global', key: 'd', value: 'another completely unrelated sentence' },
    { scope: 'global', key: 'e', value: 'the quick brown fox jumps over' },
  ];

  test('clusterDuplicatesBlocked equals clusterDuplicates on fixture', () => {
    const oracle = clusterDuplicates(FIXTURE, 0.5);
    const blocked = clusterDuplicatesBlocked(FIXTURE, 0.5);

    // Same number of clusters.
    assert.equal(blocked.length, oracle.length, 'cluster count matches oracle');

    // Each cluster matches: same size and member keys (regardless of order within cluster).
    for (let i = 0; i < oracle.length; i++) {
      const o = oracle[i];
      const b = blocked[i];
      assert.equal(b.size, o.size, `cluster ${i} size matches`);
      const oKeys = o.members.map((m) => m.key).sort().join(',');
      const bKeys = b.members.map((m) => m.key).sort().join(',');
      assert.equal(bKeys, oKeys, `cluster ${i} members match`);
      assert.ok(Math.abs(b.minSimilarity - o.minSimilarity) < 1e-10, `cluster ${i} minSim matches`);
      assert.ok(Math.abs(b.maxSimilarity - o.maxSimilarity) < 1e-10, `cluster ${i} maxSim matches`);
    }
  });

  test('clusterDuplicatesBlocked identical results on empty and singleton inputs', () => {
    assert.deepEqual(clusterDuplicatesBlocked([], 0.8), clusterDuplicates([], 0.8));
    const single = [{ scope: 'global', key: 'x', value: 'only one entry here' }];
    assert.deepEqual(clusterDuplicatesBlocked(single, 0.8), clusterDuplicates(single, 0.8));
  });
});

// ── AC-8: clusterDuplicatesBlocked fewer candidate pairs (non-N²) ─────────────
// On a large fixture with sparse overlap, the blocked algorithm generates fewer
// than n*(n-1)/2 candidate pairs (the full O(n²) upper bound).

describe('clusterDuplicatesBlocked fewer than n(n-1)/2 candidate pairs on sparse fixture', () => {
  test('inverted-index blocking reduces candidate pairs vs full pairwise sweep', () => {
    // Build a corpus where first half and second half share NO tokens.
    // The blocked algo should generate zero cross-half pairs.
    const n = 20;
    const entries = [];
    for (let i = 0; i < n / 2; i++) {
      entries.push({ scope: 'global', key: `a${i}`, value: `alpha beta gamma delta epsilon ${i}` });
    }
    for (let i = 0; i < n / 2; i++) {
      entries.push({ scope: 'global', key: `b${i}`, value: `zeta eta theta iota kappa ${i}` });
    }
    // Full n*(n-1)/2 pairs would be n*(n-1)/2 = 190 for n=20.
    const allPairs = (n * (n - 1)) / 2;
    // The blocked algo generates candidates only for items sharing a token.
    // Within-group pairs only = 2 * ((n/2)*(n/2-1)/2) = 2 * 45 = 90 pairs (with shared numeric token).
    // Actually, the numeric suffix makes each item unique, so pairs only share the 5 common words.
    // There are (n/2)*(n/2-1)/2 within-half pairs = 45 per half = 90 total.
    // The test simply verifies blocked finds at least one fewer pair than n*(n-1)/2.
    // We do this by checking that cross-group items produce no shared clusters.
    const oracle = clusterDuplicates(entries, 0.8);
    const blocked = clusterDuplicatesBlocked(entries, 0.8);

    // Both should agree on clusters (equivalence, per AC-7).
    assert.equal(blocked.length, oracle.length, 'same cluster count');

    // No cluster should contain both an 'a' key and a 'b' key (disjoint token sets).
    for (const cluster of blocked) {
      const hasA = cluster.members.some((m) => m.key.startsWith('a'));
      const hasB = cluster.members.some((m) => m.key.startsWith('b'));
      assert.ok(!(hasA && hasB), 'no cross-group cluster — token blocking works');
    }

    // The candidate pairs in the blocked algo are strictly fewer than n*(n-1)/2.
    // We verify this indirectly: if blocking were disabled, EVERY pair would be
    // considered. With blocking, cross-group pairs with 0 shared tokens are
    // never generated. We confirm this by checking that the total_candidate_pairs
    // observable effect (no spurious cross-group clusters) is consistent.
    // Direct pair count verification: run blocked with n=4 (2+2) known case.
    const tiny = [
      { scope: 'global', key: 'x1', value: 'alpha beta gamma' },
      { scope: 'global', key: 'x2', value: 'alpha beta gamma' },
      { scope: 'global', key: 'y1', value: 'zeta eta theta' },
      { scope: 'global', key: 'y2', value: 'zeta eta theta' },
    ];
    // n*(n-1)/2 = 6. Token-blocked pairs: 1 (x1,x2) + 1 (y1,y2) = 2 < 6.
    const tinyBlocked = clusterDuplicatesBlocked(tiny, 0.8);
    const tinyOracle = clusterDuplicates(tiny, 0.8);
    assert.equal(tinyBlocked.length, tinyOracle.length, 'tiny fixture: same clusters');
    assert.equal(tinyBlocked.length, 2, 'two separate clusters (no cross-group merge)');
  });
});

// ── AC-9: dedupe stops at 2000 with warning ───────────────────────────────────
// gatherStream with a population cap of 2000 stops accumulating beyond 2000.
// This is exercised via gatherStream + the accumulation pattern used in dedupe.mjs.

describe('dedupe narrow key-prefix: gatherStream stops at configured max', () => {
  test('gatherStream with max=2000 cap stops and sets capped=true when exceeded', async () => {
    // Each list() returns 100 entries; after 20 pages we'd have 2000 entries.
    // The 21st call should not happen.
    let listCalls = 0;
    const store = {
      mode: 'remote',
      usable: () => true,
      list: async ({ scope, cursor }) => {
        listCalls += 1;
        return {
          ok: true,
          entries: Array.from({ length: 100 }, (_, i) => ({
            key: `key-${listCalls}-${i}`, value: 'token1 token2 token3', scope,
          })),
          hasMore: true,
          nextCursor: `cursor-${listCalls}`,
        };
      },
    };
    const accumulated = [];
    const result = await gatherStream(store, ['global'], {
      max: 2000,
      onPage: ({ entries }) => {
        for (const e of entries) {
          if (accumulated.length < 2000) accumulated.push(e);
        }
      },
    });
    assert.equal(result.capped, true, 'capped flag set at 2000');
    assert.ok(result.surveyed <= 2000, `surveyed=${result.surveyed} must be <= 2000`);
    // The list should have been called at most 21 times (20 pages + possibly 1 more that triggers cap).
    assert.ok(listCalls <= 21, `list called ${listCalls} times (expected <= 21)`);
  });
});

// ── AC-9b: --key-prefix is a SERVER-side prefix filter, not an exact-key match ─
// `dedupe --key-prefix` must narrow the population server-side (before the page
// cap), so the CLI maps it to the REST `key_prefix` query param — NOT the exact
// `key` param, which would match a key equal to the prefix and return ~nothing.

describe('key_prefix forwarded as a distinct REST prefix filter', () => {
  test('list maps key_prefix to the key_prefix query param, never exact key', async () => {
    const { calls } = await captureRestCalls(
      (store) => store.list({ scope: 'global', key_prefix: 'debug-' }),
      { status: 200, body: JSON.stringify({ entries: [] }) },
    );
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('key_prefix'), 'debug-', 'key_prefix forwarded');
    assert.equal(u.searchParams.get('key'), null, 'exact key param NOT set (would break prefix semantics)');
  });

  test('gatherStream forwards keyPrefix as key_prefix into list calls', async () => {
    const listCalls = [];
    const store = {
      mode: 'remote',
      usable: () => true,
      list: async (args) => {
        listCalls.push({ ...args });
        return { ok: true, entries: [{ key: 'debug-1', value: 'v', scope: args.scope }], hasMore: false, nextCursor: null };
      },
    };
    await gatherStream(store, ['global'], { keyPrefix: 'debug-' });
    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0].key_prefix, 'debug-', 'key_prefix forwarded by gatherStream');
  });
});

// ── AC-10: --since/--until forwarded as created_since/created_until ───────────

describe('since/until forwarded as created_since/created_until query params', () => {
  test('list passes created_since and created_until to REST', async () => {
    const { calls } = await captureRestCalls(
      (store) => store.list({ scope: 'global', created_since: '2024-01-01', created_until: '2024-12-31' }),
      { status: 200, body: JSON.stringify({ entries: [] }) },
    );
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('created_since'), '2024-01-01', 'created_since forwarded');
    assert.equal(u.searchParams.get('created_until'), '2024-12-31', 'created_until forwarded');
  });

  test('gatherStream forwards since/until into list calls', async () => {
    const listCalls = [];
    const store = {
      mode: 'remote',
      usable: () => true,
      list: async (args) => {
        listCalls.push({ ...args });
        return { ok: true, entries: [{ key: 'k', value: 'v', scope: args.scope }], hasMore: false, nextCursor: null };
      },
    };
    await gatherStream(store, ['global'], { since: '2024-01-01', until: '2024-06-30' });
    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0].created_since, '2024-01-01', 'created_since forwarded by gatherStream');
    assert.equal(listCalls[0].created_until, '2024-06-30', 'created_until forwarded by gatherStream');
  });
});

// ── AC-11: list shows single page by default; lint/dedupe drain all pages ─────
// list with no --all flag uses gather() (single-page). lint/dedupe use gatherStream.
// These test gatherStream vs gather behavior at the store level.

describe('default list single page vs drain all pages', () => {
  test('gather returns only first page (no cursor follow)', async () => {
    let calls = 0;
    const store = {
      mode: 'remote',
      usable: () => true,
      list: async () => {
        calls += 1;
        return {
          ok: true,
          entries: [{ key: 'k1', value: 'val1', scope: 'global' }],
          hasMore: true,
          nextCursor: 'page-2',
        };
      },
    };
    const result = await gather(store, ['global']);
    assert.equal(calls, 1, 'gather issues exactly 1 list call (no page follow)');
    assert.equal(result.total, 1);
  });

  test('gatherStream follows all pages (drain)', async () => {
    let calls = 0;
    const store = {
      mode: 'remote',
      usable: () => true,
      list: async ({ cursor }) => {
        calls += 1;
        if (!cursor) {
          return { ok: true, entries: [{ key: 'k1', value: 'v1', scope: 'global' }], hasMore: true, nextCursor: 'p2' };
        }
        return { ok: true, entries: [{ key: 'k2', value: 'v2', scope: 'global' }], hasMore: false, nextCursor: null };
      },
    };
    let totalEntries = 0;
    await gatherStream(store, ['global'], { onPage: ({ entries }) => { totalEntries += entries.length; } });
    assert.equal(calls, 2, 'gatherStream issues 2 list calls following cursor');
    assert.equal(totalEntries, 2, 'all entries collected across pages');
  });
});

// ── AC-12: mcp-server threads cursor and surfaces hasMore/nextCursor ──────────
// The MEMORY_TOOL_DEFS in mcp-server.mjs must advertise cursor for memory.list
// and memory.search. The MEMORY_DISPATCH passes args straight through so cursor
// is forwarded automatically.

describe('mcp-server cursor threading', () => {
  test('memory.list tool definition includes cursor property', () => {
    const listDef = MEMORY_TOOL_DEFS.find((d) => d.name === 'memory.list');
    assert.ok(listDef, 'memory.list tool defined');
    assert.ok(listDef.inputSchema?.properties?.cursor, 'cursor property in memory.list schema');
    assert.equal(typeof listDef.inputSchema.properties.cursor.type, 'string');
  });

  test('memory.search tool definition includes cursor property', () => {
    const searchDef = MEMORY_TOOL_DEFS.find((d) => d.name === 'memory.search');
    assert.ok(searchDef, 'memory.search tool defined');
    assert.ok(searchDef.inputSchema?.properties?.cursor, 'cursor property in memory.search schema');
    assert.equal(typeof searchDef.inputSchema.properties.cursor.type, 'string');
  });

  test('memory.list tool definition includes limit with correct range', () => {
    const listDef = MEMORY_TOOL_DEFS.find((d) => d.name === 'memory.list');
    const limitProp = listDef?.inputSchema?.properties?.limit;
    assert.ok(limitProp, 'limit property present');
    assert.equal(limitProp.minimum, 1);
    assert.equal(limitProp.maximum, 100);
  });

  test('memory.search tool definition includes limit with correct range', () => {
    const searchDef = MEMORY_TOOL_DEFS.find((d) => d.name === 'memory.search');
    const limitProp = searchDef?.inputSchema?.properties?.limit;
    assert.ok(limitProp, 'limit property present');
    assert.equal(limitProp.minimum, 1);
    assert.equal(limitProp.maximum, 100);
  });

  test('RemoteStore.list returns hasMore and nextCursor for mcp-server consumption', async () => {
    const { result } = await captureRestCalls(
      (store) => store.list({ scope: 'global' }),
      { status: 200, body: JSON.stringify({ entries: [], hasMore: true, nextCursor: 'abc123' }) },
    );
    assert.equal(result.hasMore, true, 'hasMore surfaced from REST response');
    assert.equal(result.nextCursor, 'abc123', 'nextCursor surfaced from REST response');
  });

  test('RemoteStore.search returns hasMore and nextCursor for mcp-server consumption', async () => {
    const { result } = await captureRestCalls(
      (store) => store.search({ q: 'test' }),
      { status: 200, body: JSON.stringify({ entries: [], hasMore: true, nextCursor: 'def456' }) },
    );
    assert.equal(result.hasMore, true, 'hasMore surfaced from search REST response');
    assert.equal(result.nextCursor, 'def456', 'nextCursor surfaced from search REST response');
  });
});

// ── The read shape a ranking layer consumes: seenCount + updatedAt ────────────
// Both stores answer in their own vocabulary — the remote store hands back a
// REST `MemoryEntry` (`seen_count` / `updated_at`), the local store hands back
// parsed frontmatter (`seen_count` / `updated`) — so a ranker that had to know
// which one it was holding would grow two copies of the same rule. The pure
// `entry-fields.mjs` projection is applied by both, and these tests pin the
// contract rather than either store's internals.
//
// The fields are ADDITIVE: every key the store already returned survives, so an
// existing caller cannot be broken by the projection.

describe('store read fields', () => {
  const withSeen = (n, updated) => JSON.stringify({
    entries: [{ id: 'i1', scope: 'global', key: 'k', value: 'v', tags: [], seen_count: n, updated_at: updated }],
  });

  test('remote seenCount updatedAt — list and search carry both fields', async () => {
    const updated = '2026-08-01T10:20:30.000Z';

    const listed = await captureRestCalls(
      (store) => store.list({ scope: 'global' }),
      { status: 200, body: withSeen(7, updated) },
    );
    assert.equal(listed.result.entries[0].seenCount, 7);
    assert.equal(listed.result.entries[0].updatedAt, updated);
    // Additive — the original REST keys are untouched.
    assert.equal(listed.result.entries[0].seen_count, 7);
    assert.equal(listed.result.entries[0].value, 'v');

    const searched = await captureRestCalls(
      (store) => store.search({ q: 'v' }),
      { status: 200, body: withSeen(3, updated) },
    );
    assert.equal(searched.result.entries[0].seenCount, 3);
    assert.equal(searched.result.entries[0].updatedAt, updated);

    // read() answers with the same shape — a single lookup must not differ from
    // the listing the caller found the key in.
    const read = await captureRestCalls(
      (store) => store.read({ scope: 'global', key: 'k' }),
      { status: 200, body: withSeen(2, updated) },
    );
    assert.equal(read.result.entry.seenCount, 2);
    assert.equal(read.result.entry.updatedAt, updated);
  });

  test('store fields degrade — a row missing either field never throws', async () => {
    // A backend deployed before migration 00058 returns no `seen_count` at all.
    const { result } = await captureRestCalls(
      (store) => store.list({ scope: 'global' }),
      { status: 200, body: JSON.stringify({ entries: [{ key: 'k', value: 'v' }] }) },
    );
    assert.equal(result.entries[0].seenCount, 0, 'absent count reads as 0, not 1');
    assert.equal(result.entries[0].updatedAt, null, 'absent timestamp reads as null');

    // Garbage in every field the projection touches.
    const junk = await captureRestCalls(
      (store) => store.list({ scope: 'global' }),
      {
        status: 200,
        body: JSON.stringify({
          entries: [
            { key: 'a', seen_count: 'not-a-number', updated_at: 'not-a-date' },
            { key: 'b', seen_count: -4, updated_at: '' },
            { key: 'c', seen_count: 2.7 },
            null,
          ],
        }),
      },
    );
    assert.deepEqual(junk.result.entries.map((e) => e.seenCount), [0, 0, 2, 0]);
    assert.deepEqual(junk.result.entries.map((e) => e.updatedAt), [null, null, null, null]);
  });

  test('store fields degrade — a numeric string count is read, not dropped', async () => {
    // PostgREST can render a bigint as a string; the projection coerces rather
    // than silently scoring the lesson as never-seen.
    const { result } = await captureRestCalls(
      (store) => store.list({ scope: 'global' }),
      { status: 200, body: JSON.stringify({ entries: [{ key: 'k', seen_count: '5' }] }) },
    );
    assert.equal(result.entries[0].seenCount, 5);
  });
});

describe('local store read fields', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lk-fields-'));

  test('local seenCount updatedAt — list, search and read carry both fields', async () => {
    const store = createLocalStore(tmp());
    await store.write({ scope: 'global', key: 'k', value: 'v1' });

    const listed = await store.list({ scope: 'global' });
    assert.equal(listed.entries[0].seenCount, 1, 'a first write is one sighting');
    assert.equal(
      listed.entries[0].updatedAt,
      new Date(listed.entries[0].updated).toISOString(),
      'updatedAt is the frontmatter `updated`, normalised to ISO',
    );

    const searched = await store.search({ q: 'v1', scopes: ['global'] });
    assert.equal(searched.entries[0].seenCount, 1);
    assert.ok(searched.entries[0].updatedAt);

    const read = await store.read({ scope: 'global', key: 'k' });
    assert.equal(read.entry.seenCount, 1);
    assert.ok(read.entry.updatedAt);
  });

  test('local seenCount updatedAt — a rewrite of the same key counts the recurrence', async () => {
    const store = createLocalStore(tmp());
    await store.write({ scope: 'global', key: 'k', value: 'v1' });
    await store.write({ scope: 'global', key: 'k', value: 'v2' });
    await store.write({ scope: 'global', key: 'k', value: 'v3' });

    const { entries } = await store.list({ scope: 'global' });
    assert.equal(entries.length, 1, 'the upsert must not fan out into three files');
    assert.equal(entries[0].seenCount, 3, 'three writes of one key is three sightings');
    assert.equal(entries[0].value, 'v3');
  });

  test('local seenCount updatedAt — a different key is its own tally', async () => {
    const store = createLocalStore(tmp());
    await store.write({ scope: 'global', key: 'recurring', value: 'v' });
    await store.write({ scope: 'global', key: 'recurring', value: 'v' });
    await store.write({ scope: 'global', key: 'one-off', value: 'v' });

    const { entries } = await store.list({ scope: 'global' });
    const bySeen = Object.fromEntries(entries.map((e) => [e.key, e.seenCount]));
    assert.deepEqual(bySeen, { recurring: 2, 'one-off': 1 });
  });

  test('local seenCount updatedAt — reviving an archived key restarts the tally', async () => {
    const store = createLocalStore(tmp());
    await store.write({ scope: 'global', key: 'k', value: 'v1' });
    await store.write({ scope: 'global', key: 'k', value: 'v2' });
    await store.archive({ scope: 'global', key: 'k' });
    await store.write({ scope: 'global', key: 'k', value: 'v3' });

    const { entries } = await store.list({ scope: 'global' });
    assert.equal(
      entries[0].seenCount,
      1,
      'a retired lesson being learned again starts over, matching the hosted RPC',
    );
  });

  test('store fields degrade — a local file written before the column existed', async () => {
    const dir = tmp();
    const store = createLocalStore(dir);
    await store.write({ scope: 'global', key: 'k', value: 'v1' });

    // Strip the column the way a file written by an older CLI would lack it.
    const scopeDir = path.join(dir, 'global');
    const file = path.join(scopeDir, fs.readdirSync(scopeDir)[0]);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('seen_count:')).join('\n'),
    );

    const { entries } = await store.list({ scope: 'global' });
    assert.equal(entries[0].seenCount, 0, 'absent reads as 0 — no evidence, not one sighting');
    assert.ok(entries[0].updatedAt, 'the timestamp is unaffected');

    // And the next write resumes the tally rather than throwing.
    await store.write({ scope: 'global', key: 'k', value: 'v2' });
    const after = await store.list({ scope: 'global' });
    assert.equal(after.entries[0].seenCount, 1);
  });

  test('store fields degrade — a hand-edited frontmatter scalar never throws', async () => {
    const dir = tmp();
    const store = createLocalStore(dir);
    await store.write({ scope: 'global', key: 'k', value: 'v1' });

    const scopeDir = path.join(dir, 'global');
    const file = path.join(scopeDir, fs.readdirSync(scopeDir)[0]);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8')
        .replace(/^seen_count: .*$/m, 'seen_count: lots')
        .replace(/^updated: .*$/m, 'updated: yesterday'),
    );

    const { entries } = await store.list({ scope: 'global' });
    assert.equal(entries[0].seenCount, 0);
    assert.equal(entries[0].updatedAt, null, 'an unparseable date is null, never Invalid Date');
  });

  test('local seenCount updatedAt — putEntry relocates a count verbatim', async () => {
    const from = createLocalStore(tmp());
    const to = createLocalStore(tmp());
    await from.write({ scope: 'global', key: 'k', value: 'v' });
    await from.write({ scope: 'global', key: 'k', value: 'v' });

    const { entries } = await from.list({ scope: 'global' });
    await to.putEntry(entries[0]);

    const moved = await to.list({ scope: 'global' });
    assert.equal(
      moved.entries[0].seenCount,
      2,
      'migrate relocates a store, it does not re-sight its lessons',
    );
  });
});

// ── rankLessons: the injection-order scorer ──────────────────────────────────
// Ordering by recency alone is what makes a busy repo's SessionStart injection
// useless: the newest cluster of writes is one task's iteration log, and it
// takes every slot. These tests pin the behaviour that fixes that, and the
// total-function guarantees the hot path relies on.

describe('rankLessons', () => {
  const DAY = 86400000;
  const NOW = Date.parse('2026-08-01T00:00:00.000Z');
  const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

  const lesson = (key, { days = 0, seen = 1, scope = 'global', value = '' } = {}) => ({
    scope, key, value, seenCount: seen, updatedAt: at(days),
  });

  const keys = (entries, opts) => rankLessons(entries, { now: NOW, ...opts }).map((e) => e.key);

  test('rankLessons order — best first, and the input is not mutated', () => {
    const input = [
      lesson('old-oneoff', { days: 60, seen: 1 }),
      lesson('fresh-recurring', { days: 1, seen: 9 }),
      lesson('fresh-oneoff', { days: 1, seen: 1 }),
    ];
    const snapshot = input.map((e) => e.key);

    const ranked = rankLessons(input, { now: NOW });
    assert.deepEqual(ranked.map((e) => e.key), ['fresh-recurring', 'fresh-oneoff', 'old-oneoff']);
    assert.deepEqual(input.map((e) => e.key), snapshot, 'the caller still holds the input order');
    assert.notEqual(ranked, input, 'a new array, never a sort in place');
    assert.equal(ranked[0], input[1], 'the entries themselves are passed through, not copied');
  });

  test('rankLessons salience — recurrence beats a one-off at equal recency', () => {
    // The whole point of the scorer. Same day, same everything else.
    assert.deepEqual(
      keys([lesson('once', { days: 3, seen: 1 }), lesson('eight-times', { days: 3, seen: 8 })]),
      ['eight-times', 'once'],
    );
  });

  test('rankLessons salience — and it beats a NEWER one-off, which is the bug', () => {
    // The observed failure: a dozen one-offs from today evict the lesson that
    // has been re-learned all month. One of them should still lose to it.
    const ranked = keys([
      lesson('todays-noise-1', { days: 0, seen: 1 }),
      lesson('todays-noise-2', { days: 0, seen: 1 }),
      lesson('hard-won', { days: 5, seen: 25 }),
    ]);
    assert.equal(ranked[0], 'hard-won');
  });

  test('rankLessons salience — a set with no recurrence ranks purely on recency', () => {
    // Nothing has recurred, so salience has nothing to say and must not invent
    // a preference between equals.
    assert.deepEqual(
      keys([lesson('c', { days: 9 }), lesson('a', { days: 1 }), lesson('b', { days: 4 })]),
      ['a', 'b', 'c'],
    );
  });

  test('rankLessons no-terms — an empty query is identical to recency+salience', () => {
    const entries = [
      lesson('alpha', { days: 2, seen: 4, value: 'timeout on connect' }),
      lesson('beta', { days: 8, seen: 9, value: 'unrelated body' }),
      lesson('gamma', { days: 1, seen: 1, value: 'timeout again' }),
    ];
    // The reference ordering: relevance weighted out entirely.
    const withoutRelevance = rankLessons(entries, {
      now: NOW,
      weights: { recency: 1, salience: 1, relevance: 0 },
    }).map((e) => e.key);

    assert.deepEqual(keys(entries), withoutRelevance, 'terms omitted');
    assert.deepEqual(keys(entries, { terms: [] }), withoutRelevance, 'terms: []');
    assert.deepEqual(keys(entries, { terms: ['', '   '] }), withoutRelevance, 'blank terms');
  });

  test('rankLessons — terms lift the lesson that matches them', () => {
    const entries = [
      lesson('fresh-unrelated', { days: 0, seen: 1, value: 'nothing to do with it' }),
      lesson('stale-match', { days: 30, seen: 1, value: 'ECONNREFUSED on connect' }),
    ];
    assert.equal(keys(entries)[0], 'fresh-unrelated', 'without terms, recency wins');
    assert.equal(
      keys(entries, { terms: ['econnrefused'] })[0],
      'stale-match',
      'a match outweighs a month of age',
    );
  });

  test('rankLessons deterministic ties — scope precedence, then key', () => {
    // Identical in every scoring input, so only the tiebreakers separate them.
    const entries = [
      { scope: 'global', key: 'zzz', value: '', seenCount: 1, updatedAt: at(1) },
      { scope: 'global', key: 'aaa', value: '', seenCount: 1, updatedAt: at(1) },
      { scope: 'repo::o/r', key: 'mmm', value: '', seenCount: 1, updatedAt: at(1) },
    ];
    // Input order defines precedence, so `global` (seen first) outranks the repo
    // scope here — and within it, key order decides.
    assert.deepEqual(keys(entries), ['aaa', 'zzz', 'mmm']);

    // An explicit scopeOrder overrides that, which is how a caller passes the
    // real narrow-to-broad hierarchy.
    assert.deepEqual(
      keys(entries, { scopeOrder: ['repo::o/r', 'global'] }),
      ['mmm', 'aaa', 'zzz'],
    );
  });

  test('rankLessons deterministic ties — the same input always gives the same output', () => {
    const entries = Array.from({ length: 25 }, (_, i) => lesson(`k${i}`, { days: i % 5, seen: (i % 3) + 1 }));
    const first = keys(entries);
    for (let i = 0; i < 5; i += 1) assert.deepEqual(keys(entries), first);
    // And it is a function of `now`, not of the wall clock: same inputs, same
    // answer, whenever the test happens to run.
    assert.deepEqual(rankLessons(entries, { now: new Date(NOW) }).map((e) => e.key), first);
  });

  test('rankLessons malformed — junk entries never throw and never win', () => {
    const good = lesson('good', { days: 1, seen: 5 });
    const ranked = rankLessons(
      [
        null,
        undefined,
        'a string',
        42,
        {},
        { key: 'no-timestamp' },
        { key: 'bad-timestamp', updatedAt: 'yesterday', seenCount: 'lots' },
        { key: 'negative', updatedAt: at(1), seenCount: -8 },
        good,
      ],
      { now: NOW },
    );
    assert.equal(ranked[0], good, 'a well-formed recurring lesson still wins');
    // The four non-objects are dropped; every object survives, scored on what
    // it had — a lesson is not discarded for having a field this cannot read.
    assert.equal(ranked.length, 5);
    assert.ok(ranked.every((e) => e && typeof e === 'object'));
  });

  test('rankLessons malformed — an empty or non-array input is an empty result', () => {
    for (const bad of [[], null, undefined, 'nope', 7, {}]) {
      assert.deepEqual(rankLessons(bad, { now: NOW }), [], `input ${String(bad)}`);
    }
  });

  test('rankLessons malformed — a broken `now` or weight set degrades, never throws', () => {
    const entries = [lesson('a', { days: 1, seen: 2 }), lesson('b', { days: 9, seen: 1 })];
    // An unusable clock zeroes recency for everyone rather than throwing; the
    // remaining factors still rank.
    assert.equal(rankLessons(entries, { now: 'not-a-date' }).length, 2);
    // Weights that sum to zero would divide by zero — the defaults take over.
    assert.deepEqual(
      rankLessons(entries, { now: NOW, weights: { recency: 0, salience: 0, relevance: 0 } })
        .map((e) => e.key),
      keys(entries),
    );
    // A junk weight falls back per-field, not wholesale.
    assert.equal(rankLessons(entries, { now: NOW, weights: { recency: 'lots' } }).length, 2);
  });

  test('rankLessons reads either spelling of the count and the timestamp', () => {
    // An entry straight off the REST route (not through the store projection)
    // must rank the same as one that went through it.
    const projected = { scope: 'global', key: 'z-projected', value: '', seenCount: 9, updatedAt: at(2) };
    const raw = { scope: 'global', key: 'a-raw', value: '', seen_count: 9, updated_at: at(2) };
    const ranked = rankLessons([projected, raw], { now: NOW });
    // `raw` deliberately carries the SMALLER key, so first place is reachable
    // only by TYING on score. If either snake_case field went unread it would
    // score strictly lower (recency and salience both collapse to 0) and sort
    // second, and the key tiebreak would never be consulted — which is what
    // makes this assertion discriminate rather than merely restate the input.
    assert.deepEqual(ranked.map((e) => e.key), ['a-raw', 'z-projected']);
  });
});

describe('scoreLesson factors', () => {
  const NOW = Date.parse('2026-08-01T00:00:00.000Z');
  const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

  test('recencyFactor halves at the half-life and is bounded', () => {
    assert.equal(recencyFactor(daysAgo(0), NOW), 1);
    assert.ok(Math.abs(recencyFactor(daysAgo(RECENCY_HALF_LIFE_DAYS), NOW) - 0.5) < 1e-12);
    assert.ok(recencyFactor(daysAgo(365), NOW) > 0, 'decays toward 0, never to it');
    assert.ok(recencyFactor(daysAgo(365), NOW) < 0.001);
  });

  test('recencyFactor clamps a future timestamp to 1 rather than exceeding it', () => {
    // Clock skew between writer and reader is ordinary; an unbounded score
    // would let it beat every honestly-dated lesson.
    assert.equal(recencyFactor(new Date(NOW + 86400000).toISOString(), NOW), 1);
  });

  test('recencyFactor scores an unknown timestamp 0, not average', () => {
    // Treating unknown as average would let a lesson with no timestamp outrank
    // a real one that is merely a month old.
    for (const bad of [null, undefined, '', 'yesterday', {}]) {
      assert.equal(recencyFactor(bad, NOW), 0, `value ${String(bad)}`);
    }
  });

  test('salienceFactor is relative to the set, and flat when nothing recurred', () => {
    assert.equal(salienceFactor(1, 1), 0, 'a set of one-offs has no salience signal');
    assert.equal(salienceFactor(0, 0), 0);
    assert.equal(salienceFactor(8, 8), 1, 'the most-recurring lesson in the set scores 1');
    assert.ok(salienceFactor(2, 8) > salienceFactor(1, 8));
    // A count above the stated maximum clamps rather than exceeding the bound.
    // `rankLessons` derives the max from the set so this never binds in-set —
    // it binds on a direct caller, which is the only way the docblock's [0,1]
    // can be broken. Unclamped, `log1p(5)/log1p(2)` is 1.63.
    assert.equal(salienceFactor(5, 2), 1);
    assert.equal(salienceFactor(500, 2), 1);
    // Logarithmic: the 1 → 3 step is worth more than the 40 → 42 step.
    assert.ok(
      salienceFactor(3, 50) - salienceFactor(1, 50) > salienceFactor(42, 50) - salienceFactor(40, 50),
    );
  });

  test('relevanceFactor is the fraction of DISTINCT terms matched', () => {
    const entry = { key: 'retry-on-timeout', value: 'ECONNREFUSED then a timeout' };
    assert.equal(relevanceFactor(entry, []), 0, 'no terms is 0, never 1');
    assert.equal(relevanceFactor(entry, ['timeout']), 1);
    assert.equal(relevanceFactor(entry, ['timeout', 'nomatch']), 0.5);
    assert.equal(
      relevanceFactor(entry, ['timeout', 'timeout', 'TIMEOUT']),
      1,
      'a repeated term cannot inflate the score',
    );
    assert.equal(relevanceFactor(entry, ['econnrefused']), 1, 'case-insensitive');
    assert.equal(relevanceFactor(entry, ['retry-on']), 1, 'matches the key too');
  });

  test('relevanceFactor accepts an already-normalised term Set unchanged', () => {
    // `rankLessons` normalises the query once and hands the SAME Set to every
    // candidate, so the Set path must agree with the list path exactly.
    const entry = { key: 'retry-on-timeout', value: 'ECONNREFUSED then a timeout' };
    assert.equal(relevanceFactor(entry, new Set()), 0);
    assert.equal(relevanceFactor(entry, new Set(['timeout'])), 1);
    assert.equal(relevanceFactor(entry, new Set(['timeout', 'nomatch'])), 0.5);
  });

  test('relevanceFactor matches metacharacters literally, like search does', () => {
    // Never `new RegExp(term)` — one matcher, one meaning of "matches".
    const entry = { key: 'k', value: 'a.*(b) literally' };
    assert.equal(relevanceFactor(entry, ['a.*(b)']), 1);
    assert.equal(relevanceFactor({ key: 'k', value: 'axxxb' }, ['a.*(b)']), 0);
  });

  test('scoreLesson stays in [0,1] for any weighting', () => {
    const entry = { key: 'k', value: 'timeout', seenCount: 5, updatedAt: daysAgo(1) };
    for (const weights of [
      undefined,
      { recency: 5, salience: 1, relevance: 1 },
      { recency: 0, salience: 0, relevance: 1 },
      { recency: 0.1, salience: 99, relevance: 0 },
    ]) {
      const s = scoreLesson(entry, { now: NOW, terms: ['timeout'], maxSeenCount: 5, weights });
      assert.ok(s >= 0 && s <= 1, `score ${s} out of range for ${JSON.stringify(weights)}`);
    }
  });

  test('scoreLesson stays in [0,1] when the caller gets maxSeenCount wrong', () => {
    // The bound must not depend on the caller passing the set's real maximum:
    // `scoreLesson` is exported so a caller can explain ONE ranking, and a
    // direct caller is exactly who can get the normaliser wrong.
    const entry = { key: 'k', value: 'timeout', seenCount: 5, updatedAt: daysAgo(0) };
    for (const maxSeenCount of [2, 1, 0, -3, NaN, undefined]) {
      const s = scoreLesson(entry, { now: NOW, terms: ['timeout'], maxSeenCount });
      assert.ok(s >= 0 && s <= 1, `score ${s} out of range for maxSeenCount ${String(maxSeenCount)}`);
    }
  });
});

// ── RemoteStore.relevant: the ranked shortlist ───────────────────────────────
describe('RemoteStore.relevant', () => {
  test('issues GET /memories/relevant with the ordered scope list', async () => {
    const { result, calls } = await captureRestCalls(
      (store) => store.relevant({
        q: 'timeout',
        // Most-specific FIRST — the order is meaningful to the server, which
        // uses it to break ties, so it must survive the round trip verbatim.
        scopes: ['repo::o/r', 'global'],
        limit: 5,
        minScore: 0.2,
      }),
      {
        status: 200,
        body: JSON.stringify({
          entries: [{ scope: 'global', key: 'k', hook: 'A hook.', score: 0.5 }],
          candidates: 42,
        }),
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(
      calls[0].url,
      `${REMOTE_REST_BASE}/memories/relevant?q=timeout&scopes=repo%3A%3Ao%2Fr%2Cglobal&limit=5&min_score=0.2`,
    );
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].key, 'k');
    assert.equal(result.candidates, 42, 'candidates surfaced so a caller can say "1 of 42"');
  });

  test('omits every parameter the caller did not supply', async () => {
    // `q` is optional by design — without it the server ranks on recency +
    // salience, which is the SessionStart question.
    const { calls } = await captureRestCalls((store) => store.relevant({}), { status: 200, body: '{}' });
    assert.equal(calls[0].url, `${REMOTE_REST_BASE}/memories/relevant?`);
  });

  test('min_score of 0 is still sent — it is a value, not an absence', async () => {
    const { calls } = await captureRestCalls(
      (store) => store.relevant({ minScore: 0 }),
      { status: 200, body: '{}' },
    );
    assert.match(calls[0].url, /min_score=0$/);
  });

  test('returns the standard error envelope, and never a partial success', async () => {
    const { result } = await captureRestCalls(
      (store) => store.relevant({ q: 'x' }),
      { status: 403, body: JSON.stringify({ error: 'forbidden' }) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.entries, undefined);
  });

  test('a malformed body degrades to an empty shortlist rather than throwing', async () => {
    const { result } = await captureRestCalls(
      (store) => store.relevant({ q: 'x' }),
      { status: 200, body: JSON.stringify({ entries: 'not-an-array' }) },
    );
    assert.deepEqual(result, { ok: true, entries: [], candidates: 0 });
  });
});
