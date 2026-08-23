import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MIX,
  MCP_TOOL_FOR_OP,
  buildOpSequence,
  buildRampRungs,
  buildSchedule,
  checkRateHeadroom,
  checkServiceCredential,
  classifyMcpResponse,
  dbShare,
  describeSupabaseKey,
  diffQueryStats,
  limitedShareOfMix,
  mcpArgumentsFor,
  outcomeOf,
  percentile,
  projectRefFromUrl,
  rampVerdict,
  resolveAuthMode,
  resolveSurface,
  resolveTarget,
  summarize,
  totals,
} from './load-test-lib.mjs';

/**
 * These cover the load test's judgement calls, not its plumbing. Each one is a
 * decision that produces a plausible-looking wrong number when it drifts:
 * a target that defaults, a closed-loop schedule, an interpolated percentile,
 * a 429 counted as a failure, or a cumulative counter reported as a delta.
 */

// ── target resolution ────────────────────────────────────────────────────────

test('there is no default target', () => {
  // A load test writes real rows to a real deployment. "Forgot the flag" must
  // fail, never pick something.
  assert.equal(resolveTarget(undefined, {}).ok, false);
  assert.match(resolveTarget(undefined, {}).error, /no default/i);
  assert.equal(resolveTarget('', {}).ok, false);
  assert.equal(resolveTarget('   ', {}).ok, false);
});

test('production must be named in full, never reached by omission or abbreviation', () => {
  assert.equal(resolveTarget('production', {}).target, 'production');
  for (const near of ['prod', 'PRODUCTIO', 'live', 'main']) {
    assert.equal(resolveTarget(near, {}).ok, false, `"${near}" must not resolve`);
  }
});

test('target accepts either the flag or the env var, flag winning', () => {
  assert.equal(resolveTarget('preview', {}).target, 'preview');
  assert.equal(resolveTarget(undefined, { LOREKIT_LOAD_TARGET: 'preview' }).target, 'preview');
  assert.equal(resolveTarget('PREVIEW', {}).target, 'preview', 'case-insensitive');
  assert.equal(
    resolveTarget('preview', { LOREKIT_LOAD_TARGET: 'production' }).target,
    'preview',
    'the explicit flag wins over the ambient env var',
  );
});

// ── schedule ─────────────────────────────────────────────────────────────────

test('the schedule is open loop: offsets are fixed up front from the rate', () => {
  const s = buildSchedule({ rps: 10, durationSec: 2 });
  assert.equal(s.length, 20, '10 rps for 2 s is 20 requests');
  assert.equal(s[0], 0);
  assert.equal(s[1], 100, 'evenly spaced at 1000/rps');
  assert.equal(s.at(-1), 1900);
  // The whole point: the plan does not depend on any response, so a slow server
  // cannot reduce the offered load.
  assert.deepEqual(s, [...s].sort((a, b) => a - b), 'monotonic');
});

test('a fractional rate still spaces evenly', () => {
  const s = buildSchedule({ rps: 2.5, durationSec: 4 });
  assert.equal(s.length, 10);
  assert.equal(s[1], 400);
});

test('a degenerate rate or duration yields no requests rather than throwing', () => {
  for (const cfg of [{ rps: 0, durationSec: 10 }, { rps: 10, durationSec: 0 }, { rps: -1, durationSec: 5 }]) {
    assert.deepEqual(buildSchedule(cfg), []);
  }
});

// ── op mix ───────────────────────────────────────────────────────────────────

test('the op sequence is deterministic, so two runs issue the same requests', () => {
  const a = buildOpSequence(200);
  const b = buildOpSequence(200);
  assert.deepEqual(a, b, 'a difference between runs must be the system, not the dice');
});

test('the mix honours weights and includes the rate-limited write path', () => {
  const seq = buildOpSequence(1000);
  const share = (op) => seq.filter((o) => o === op).length / seq.length;
  // 50/25/10/15 in DEFAULT_MIX, within rounding of the round-robin.
  assert.ok(Math.abs(share('list') - 0.50) < 0.02, `list ${share('list')}`);
  assert.ok(Math.abs(share('search') - 0.25) < 0.02, `search ${share('search')}`);
  // A load test that never writes never exercises the cap trigger or produces
  // the first 429 — so the write path must be present.
  assert.ok(share('write') > 0, 'the write path must be in the mix');
  assert.equal(DEFAULT_MIX.reduce((n, m) => n + m.weight, 0), 100);
});

test('a SHORT run still issues every op — the grouped-pool bug', () => {
  // Regression guard. A `pool[i % pool.length]` over a grouped expansion (50
  // `list`, then 25 `search`, then 10 `scopes`, then 15 `write`) never reaches
  // the tail for a run shorter than the total weight: a 75-request run issued
  // only list and search, so `write` — the one rate-limited route and the only
  // one that exercises the cap trigger — was silently never sent. The
  // 1000-length test above passes either way, which is why this one exists.
  for (const n of [20, 40, 75, 99]) {
    const seq = buildOpSequence(n);
    const present = new Set(seq);
    for (const { op } of DEFAULT_MIX) {
      assert.ok(present.has(op), `a ${n}-request run must still issue "${op}" (got ${[...present].join(', ')})`);
    }
  }
});

test('short-run proportions still track the weights', () => {
  const seq = buildOpSequence(100);
  const share = (op) => seq.filter((o) => o === op).length / seq.length;
  assert.ok(Math.abs(share('list') - 0.50) < 0.03, `list ${share('list')}`);
  assert.ok(Math.abs(share('write') - 0.15) < 0.03, `write ${share('write')}`);
  assert.ok(Math.abs(share('scopes') - 0.10) < 0.03, `scopes ${share('scopes')}`);
});

test('an empty mix or zero length yields nothing', () => {
  assert.deepEqual(buildOpSequence(0), []);
  assert.deepEqual(buildOpSequence(10, []), []);
  assert.deepEqual(buildOpSequence(10, [{ op: 'x', weight: 0 }]), []);
});

// ── percentiles ──────────────────────────────────────────────────────────────

test('percentiles are nearest-rank — every value was actually observed', () => {
  const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(s, 0.5), 50);
  assert.equal(percentile(s, 0.95), 100);
  assert.equal(percentile(s, 0.99), 100);
  // The guard: an interpolating implementation would return 95 for p95 here,
  // a number never measured.
  assert.ok(s.includes(percentile(s, 0.95)));
});

test('percentiles handle the boundaries and the empty case', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.99), 7);
  assert.equal(percentile([3, 1, 2], 0), 1, 'p0 is the min');
  assert.equal(percentile([3, 1, 2], 1), 3, 'p100 is the max');
});

test('percentiles do not mutate the caller array', () => {
  const s = [3, 1, 2];
  percentile(s, 0.5);
  assert.deepEqual(s, [3, 1, 2]);
});

// ── summaries ────────────────────────────────────────────────────────────────

const RESULTS = [
  { op: 'list', status: 200, ms: 100 },
  { op: 'list', status: 200, ms: 200 },
  { op: 'list', status: 429, ms: 3 },
  { op: 'list', status: 500, ms: 900 },
  { op: 'write', status: 201, ms: 50 },
  { op: 'write', status: 0, ms: 5000 },
];

test('a 429 is the guardrail working, not an error', () => {
  const [list] = summarize(RESULTS);
  assert.equal(list.op, 'list');
  assert.equal(list.rateLimited, 1);
  assert.equal(list.errors, 1, 'only the 500 counts as an error');
  assert.equal(list.ok, 2);
  assert.equal(list.count, 4);
});

test('a transport failure (status 0) counts as an error', () => {
  const write = summarize(RESULTS).find((r) => r.op === 'write');
  assert.equal(write.errors, 1);
  assert.equal(write.ok, 1);
});

test('latency percentiles cover successful requests ONLY', () => {
  const [list] = summarize(RESULTS);
  // The 429 (3 ms) and the 500 (900 ms) are excluded, so p50 over {100, 200}.
  assert.equal(list.p50, 100);
  assert.equal(list.max, 200, 'the 900 ms error must not become the max');
});

test('totals aggregate across ops', () => {
  const t = totals(RESULTS);
  assert.equal(t.requests, 6);
  assert.equal(t.ok, 3);
  assert.equal(t.rateLimited, 1);
  assert.equal(t.errors, 2, 'the 500 and the transport failure');
});

// ── query-stats diff ─────────────────────────────────────────────────────────

const BEFORE = [
  { queryid: '1', query: 'select … from memories', calls: 100, total_exec_ms: 1000, rows_returned: 500 },
  { queryid: '2', query: 'idle statement', calls: 5, total_exec_ms: 50, rows_returned: 5 },
];

test('the diff describes THIS run, not cumulative history', () => {
  const after = [
    { queryid: '1', query: 'select … from memories', calls: 150, total_exec_ms: 1600, rows_returned: 800 },
    { queryid: '2', query: 'idle statement', calls: 5, total_exec_ms: 50, rows_returned: 5 },
  ];
  const d = diffQueryStats(BEFORE, after);
  assert.equal(d.length, 1, 'a statement with no calls in the window is dropped');
  assert.equal(d[0].queryid, '1');
  assert.equal(d[0].calls, 50);
  assert.equal(d[0].totalMs, 600);
  assert.equal(d[0].meanMs, 12);
  assert.equal(d[0].rows, 300);
});

test('a statement first seen during the run counts fully and is flagged new', () => {
  const after = [...BEFORE, { queryid: '9', query: 'insert into memories …', calls: 20, total_exec_ms: 200, rows_returned: 20 }];
  const fresh = diffQueryStats(BEFORE, after).find((r) => r.queryid === '9');
  assert.equal(fresh.calls, 20);
  assert.equal(fresh.totalMs, 200);
  assert.equal(fresh.isNew, true);
});

test('a mid-run stats_reset is dropped, never reported as negative work', () => {
  const after = [{ queryid: '1', query: 'select …', calls: 110, total_exec_ms: 40, rows_returned: 10 }];
  assert.deepEqual(diffQueryStats(BEFORE, after), []);
});

test('the diff is ordered by time spent, which is what you act on', () => {
  const after = [
    { queryid: '1', query: 'cheap but frequent', calls: 200, total_exec_ms: 1100, rows_returned: 0 },
    { queryid: '7', query: 'rare but slow', calls: 2, total_exec_ms: 900, rows_returned: 2 },
  ];
  const d = diffQueryStats(BEFORE, after);
  assert.deepEqual(d.map((r) => r.queryid), ['7', '1'], '900 ms delta outranks a 100 ms delta');
});

test('missing snapshots degrade to an empty diff', () => {
  assert.deepEqual(diffQueryStats(undefined, undefined), []);
  assert.deepEqual(diffQueryStats(null, []), []);
});

// ── db share ─────────────────────────────────────────────────────────────────

test('dbShare reports both terms, because they are measured differently', () => {
  const share = dbShare(
    [{ op: 'list', status: 200, ms: 100 }, { op: 'list', status: 200, ms: 100 }],
    [{ totalMs: 120 }],
  );
  assert.equal(share.clientMs, 200);
  assert.equal(share.dbMs, 120);
  assert.equal(share.ratio, 0.6);
});

test('a ratio above 1 is legal — that is what concurrency looks like', () => {
  const share = dbShare([{ op: 'x', status: 200, ms: 100 }], [{ totalMs: 400 }]);
  assert.equal(share.ratio, 4);
});

test('no successful requests yields null rather than a divide by zero', () => {
  assert.equal(dbShare([{ op: 'x', status: 500, ms: 10 }], [{ totalMs: 5 }]), null);
  assert.equal(dbShare([], []), null);
});

// ── credential pre-flight ────────────────────────────────────────────────────

/**
 * These exist because of a real CI round-trip: run 32582427757 provisioned
 * nothing and died on
 *   POST /auth/v1/admin/users → 401 {"message":"Invalid API key"}
 * which is the SAME response Supabase gives for a key from another project, an
 * anon key in the service slot, and a revoked key. The 401 is true and useless;
 * a legacy JWT is self-describing, so the distinction is decidable offline.
 */

/** Mint a legacy-shaped JWT. Only the payload is read, so the parts around it need not verify. */
const legacyKey = (claims) =>
  ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

test('a legacy JWT is decoded to its role and project ref', () => {
  const d = describeSupabaseKey(legacyKey({ role: 'service_role', ref: 'abcdefghijklmnopqrst' }));
  assert.equal(d.format, 'legacy-jwt');
  assert.equal(d.role, 'service_role');
  assert.equal(d.ref, 'abcdefghijklmnopqrst');
  assert.equal(d.privileged, true);
});

test('the two current key formats are told apart by privilege', () => {
  assert.deepEqual(describeSupabaseKey('sb_secret_abc123'), { format: 'new-secret', privileged: true });
  assert.deepEqual(describeSupabaseKey('sb_publishable_abc123'), { format: 'new-publishable', privileged: false });
});

test('an unrecognised key is `unknown`, never invalid', () => {
  // A self-hosted or future key shape must not be reported as broken.
  assert.equal(describeSupabaseKey('some-opaque-thing').format, 'unknown');
  assert.equal(describeSupabaseKey('a.b.c').format, 'unknown'); // 3 parts, undecodable payload
  assert.equal(describeSupabaseKey('').format, 'absent');
  assert.equal(describeSupabaseKey(undefined).format, 'absent');
});

test('a project ref is read from a hosted URL only', () => {
  assert.equal(projectRefFromUrl('https://pqokxlhvnosogizsjztg.supabase.co'), 'pqokxlhvnosogizsjztg');
  assert.equal(projectRefFromUrl('https://pqokxlhvnosogizsjztg.supabase.co/'), 'pqokxlhvnosogizsjztg');
  // Self-hosted: unknown rather than guessed, so no mismatch is ever asserted.
  assert.equal(projectRefFromUrl('http://localhost:54321'), undefined);
  assert.equal(projectRefFromUrl('https://supabase.example.com'), undefined);
});

test('a valid service_role JWT for the right project passes clean', () => {
  const r = checkServiceCredential({
    serviceKey: legacyKey({ role: 'service_role', ref: 'projectone' }),
    anonKey: legacyKey({ role: 'anon', ref: 'projectone' }),
    supabaseUrl: 'https://projectone.supabase.co',
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('a key from ANOTHER project is named as a mismatch, not a bad key', () => {
  const r = checkServiceCredential({
    serviceKey: legacyKey({ role: 'service_role', ref: 'production' }),
    anonKey: legacyKey({ role: 'anon', ref: 'previewproj' }),
    supabaseUrl: 'https://previewproj.supabase.co',
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /belongs to project "production".*is project "previewproj"/);
});

test('an anon key in the service slot is rejected by role', () => {
  const r = checkServiceCredential({
    serviceKey: legacyKey({ role: 'anon', ref: 'projectone' }),
    anonKey: legacyKey({ role: 'anon', ref: 'projectone' }),
    supabaseUrl: 'https://projectone.supabase.co',
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /role "anon", not "service_role"/);
});

test('a publishable key in the service slot is rejected by format', () => {
  const r = checkServiceCredential({
    serviceKey: 'sb_publishable_xyz',
    anonKey: 'sb_publishable_xyz',
    supabaseUrl: 'https://projectone.supabase.co',
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /browser-safe key/);
});

test('swapped keys are caught even when both are for the right project', () => {
  const r = checkServiceCredential({
    serviceKey: legacyKey({ role: 'anon', ref: 'projectone' }),
    anonKey: legacyKey({ role: 'service_role', ref: 'projectone' }),
    supabaseUrl: 'https://projectone.supabase.co',
  });
  assert.equal(r.errors.length, 2); // wrong role in service slot AND privileged anon
  assert.ok(r.errors.some((e) => /privileged key/.test(e)));
});

test('an opaque secret key WARNS but never blocks — it cannot be checked offline', () => {
  const r = checkServiceCredential({
    serviceKey: 'sb_secret_xyz',
    anonKey: 'sb_publishable_xyz',
    supabaseUrl: 'https://projectone.supabase.co',
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /cannot be checked offline/);
});

test('a self-hosted URL asserts no mismatch', () => {
  // The ref is unknowable from the URL, so a ref-bearing key must not be
  // reported as belonging to the wrong project.
  const r = checkServiceCredential({
    serviceKey: legacyKey({ role: 'service_role', ref: 'anything' }),
    anonKey: legacyKey({ role: 'anon', ref: 'anything' }),
    supabaseUrl: 'http://localhost:54321',
  });
  assert.deepEqual(r.errors, []);
});

// ── surface / auth resolution ────────────────────────────────────────────────

/**
 * These exist because the REST arm was mistaken for whole-system coverage. REST
 * is the DASHBOARD's path; agents use MCP, which has its own handlers, its own
 * auth span, and rate-limits every method. The pair (surface, auth) is what
 * identifies a real caller, so both dimensions are resolved and both defaulted.
 */

test('the surface defaults to rest and rejects anything unknown', () => {
  assert.equal(resolveSurface(undefined, {}).surface, 'rest');
  assert.equal(resolveSurface('mcp', {}).surface, 'mcp');
  assert.equal(resolveSurface('MCP', {}).surface, 'mcp', 'case-insensitive');
  assert.equal(resolveSurface(undefined, { LOREKIT_LOAD_SURFACE: 'mcp' }).surface, 'mcp');
  assert.equal(resolveSurface('grpc', {}).ok, false);
});

test('auth defaults to the tier each surface is really called with', () => {
  // mcp -> token: agents hold `lk_rw_*`. rest -> jwt: the dashboard holds a JWT.
  assert.equal(resolveAuthMode(undefined, 'mcp').auth, 'token');
  assert.equal(resolveAuthMode(undefined, 'rest').auth, 'jwt');
  // rest + token is the CLI's remote mode — a DIFFERENT branch of
  // resolveRestAuth than the dashboard's, so it must be reachable.
  assert.equal(resolveAuthMode('token', 'rest').auth, 'token');
  assert.equal(resolveAuthMode('oauth', 'rest').ok, false);
});

// ── MCP wire shape ───────────────────────────────────────────────────────────

test('every op in the default mix maps to a real MCP tool', () => {
  for (const { op } of DEFAULT_MIX) {
    assert.ok(MCP_TOOL_FOR_OP[op], `no MCP tool for "${op}"`);
    assert.match(MCP_TOOL_FOR_OP[op], /^memory\./);
  }
});

test('MCP arguments satisfy each tool\'s required fields', () => {
  // Straight from the catalog: list->scope, search->q, write->scope/key/value,
  // scopes->none. A missing one returns HTTP 200 with a JSON-RPC error, so this
  // is not a cosmetic assertion.
  const ctx = { scope: 'global', key: 'k', value: 'v' };
  assert.deepEqual(Object.keys(mcpArgumentsFor('scopes', ctx)), []);
  assert.ok('scope' in mcpArgumentsFor('list', ctx));
  assert.ok('q' in mcpArgumentsFor('search', ctx));
  for (const f of ['scope', 'key', 'value']) assert.ok(f in mcpArgumentsFor('write', ctx), `write needs ${f}`);
});

test('search takes `scopes` (array) and list takes `scope` — not interchangeable', () => {
  const a = mcpArgumentsFor('search', { scope: 'global' });
  assert.ok(Array.isArray(a.scopes), 'search.scopes must be an array');
  assert.equal(a.scope, undefined, 'search must not send the singular form');
  const l = mcpArgumentsFor('list', { scope: 'global' });
  assert.equal(typeof l.scope, 'string');
  assert.equal(l.scopes, undefined, 'list must not send the plural form');
});

test('an unmapped op throws rather than sending an empty tool call', () => {
  assert.throws(() => mcpArgumentsFor('teleport', {}), /no MCP mapping/);
});

// ── the JSON-RPC trap ────────────────────────────────────────────────────────

test('a JSON-RPC error inside a 200 is an ERROR, not a success', () => {
  // THE trap of this transport. A driver that checks only the status code
  // reports a perfect run having failed every single request.
  assert.equal(classifyMcpResponse({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } } }), 'error');
  assert.equal(classifyMcpResponse({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [] } } }), 'ok');
});

test('a tool-level isError is an error even though the call succeeded', () => {
  assert.equal(classifyMcpResponse({ status: 200, body: { result: { isError: true, content: [{ type: 'text', text: 'memory cap reached' }] } } }), 'error');
});

test('429 is read before the body — the limiter answers above JSON-RPC', () => {
  assert.equal(classifyMcpResponse({ status: 429, body: null }), 'rate_limited');
  // Even if a body somehow accompanies it.
  assert.equal(classifyMcpResponse({ status: 429, body: { error: { code: -32000 } } }), 'rate_limited');
});

test('transport failures and non-2xx are errors', () => {
  assert.equal(classifyMcpResponse({ status: 0, body: null }), 'error');
  assert.equal(classifyMcpResponse({ status: 500, body: null }), 'error');
  assert.equal(classifyMcpResponse({ status: 200, body: null }), 'error', 'a 200 with no parseable body is not a success');
});

// ── rate-limit headroom ──────────────────────────────────────────────────────

test('MCP counts every method; REST counts only the write share', () => {
  assert.equal(limitedShareOfMix('mcp'), 1);
  // DEFAULT_MIX is 15/100 write.
  assert.ok(Math.abs(limitedShareOfMix('rest') - 0.15) < 1e-9);
});

test('the harness\'s OWN defaults are refused on MCP — the guard that matters', () => {
  // 20 rps / 5 users = 4 rps/user against a 2 rps/user ceiling. Half the run
  // would 429 and the percentiles would describe the guardrail. This must fail.
  const r = checkRateHeadroom({ surface: 'mcp', rps: 20, users: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.requiredUsers, 10);
  assert.match(r.error, /needs at least 10 users/);
  assert.match(r.error, /Raise --users to 10, or lower --rps to 10/);
});

test('the same settings are fine on REST, because reads are ungated', () => {
  // Only 15% of 20 rps is limited = 3 rps, i.e. 0.6 rps/user over 5 users.
  const r = checkRateHeadroom({ surface: 'rest', rps: 20, users: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.requiredUsers, 2);
});

test('a raised per-user ceiling reduces the users needed', () => {
  // The real ceiling is lorekit_get_limit(user,'requests_per_minute'); 120 is
  // only the default and a user_limits row can raise it.
  const r = checkRateHeadroom({ surface: 'mcp', rps: 20, users: 2, requestsPerMinute: 600 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.requiredUsers, 2);
});

test('stress rates need proportionally many users on MCP', () => {
  assert.equal(checkRateHeadroom({ surface: 'mcp', rps: 100, users: 1 }).requiredUsers, 50);
  assert.equal(checkRateHeadroom({ surface: 'mcp', rps: 200, users: 1 }).requiredUsers, 100);
});

// ── ramp / stress ────────────────────────────────────────────────────────────

test('the ramp is geometric and always includes the ceiling', () => {
  assert.deepEqual(buildRampRungs({ startRps: 20, maxRps: 160 }), [20, 40, 80, 160]);
  // Overshooting factor must not drop or exceed the stated max.
  assert.deepEqual(buildRampRungs({ startRps: 20, maxRps: 100 }), [20, 40, 80, 100]);
  assert.deepEqual(buildRampRungs({ startRps: 20, maxRps: 20 }), [20]);
  assert.deepEqual(buildRampRungs({ startRps: 0, maxRps: 100 }), []);
  assert.deepEqual(buildRampRungs({ startRps: 50, maxRps: 10 }), [], 'max below start yields nothing');
});

test('the ladder stops on errors, latency, 429s, or a saturated client', () => {
  const good = { count: 1000, errors: 0, rateLimited: 0, p99: 800, requestedRps: 20, achievedRps: 19.8 };
  assert.equal(rampVerdict(good).stop, false);

  assert.match(rampVerdict({ ...good, errors: 50 }).reason, /error rate/);
  assert.match(rampVerdict({ ...good, p99: 9000 }).reason, /p99/);
  // 429s end the USEFUL ladder without meaning the service failed.
  assert.match(rampVerdict({ ...good, rateLimited: 100 }).reason, /measuring the rate limiter/);
  // Client saturation must be named as such, not misread as the service slowing.
  assert.match(rampVerdict({ ...good, achievedRps: 12 }).reason, /CLIENT saturated/);
});

test('a rung with no completed requests stops the ladder', () => {
  assert.equal(rampVerdict({ count: 0 }).stop, true);
});

test('an MCP failure inside a 200 is summarised as an error, not a success', () => {
  // The classifier is worthless unless the SUMMARY honours it. Without this,
  // the MCP arm reports every failed tool call as ok.
  const rs = [
    { op: 'write', status: 200, ms: 100, outcome: 'ok' },
    { op: 'write', status: 200, ms: 110, outcome: 'error' },       // JSON-RPC error
    { op: 'write', status: 429, ms: 3, outcome: 'rate_limited' },
  ];
  const [w] = summarize(rs);
  assert.equal(w.ok, 1);
  assert.equal(w.errors, 1, 'the 200-with-error must not count as ok');
  assert.equal(w.rateLimited, 1);
  assert.equal(w.p50, 100, 'only the genuine success contributes latency');
  assert.equal(totals(rs).errors, 1);
});

test('REST results with no explicit outcome behave exactly as before', () => {
  // Regression guard on the fallback: adding the outcome field must not change
  // how the REST arm is scored.
  assert.equal(outcomeOf({ status: 200 }), 'ok');
  assert.equal(outcomeOf({ status: 201 }), 'ok');
  assert.equal(outcomeOf({ status: 429 }), 'rate_limited');
  assert.equal(outcomeOf({ status: 500 }), 'error');
  assert.equal(outcomeOf({ status: 0 }), 'error');
  assert.equal(outcomeOf({ status: 404 }), 'client_error');
  // An explicit outcome always wins.
  assert.equal(outcomeOf({ status: 200, outcome: 'error' }), 'error');
});
