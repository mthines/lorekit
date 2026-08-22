import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MIX,
  buildOpSequence,
  buildSchedule,
  dbShare,
  diffQueryStats,
  percentile,
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
