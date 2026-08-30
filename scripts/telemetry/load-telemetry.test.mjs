import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTracePayload, buildMetricsPayload } from './load-telemetry.mjs';

/**
 * OTLP payload-shape tests for the load exporter. Same reasoning as
 * `sweep-telemetry.test.mjs`: a malformed body is a 400 from the ingress, and
 * the only symptom is a dashboard that never gains a datapoint on a job that
 * runs rarely.
 */

const RUN = {
  target: 'preview', rps: 20, durationSec: 60, users: 5,
  startMs: Date.parse('2026-08-22T12:00:00Z'),
  endMs: Date.parse('2026-08-22T12:01:00Z'),
};

const SUMMARY = [
  { op: 'list', count: 600, ok: 590, rateLimited: 8, clientErrors: 0, errors: 2, p50: 40, p95: 120, p99: 300, max: 400 },
  { op: 'write', count: 180, ok: 150, rateLimited: 30, clientErrors: 0, errors: 0, p50: 60, p95: 400, p99: 900, max: 1000 },
];

const AGG = { requests: 780, ok: 740, rateLimited: 38, errors: 2, p50: 45, p95: 180, p99: 600 };

const QUERY_DIFF = [
  { queryid: '-42', query: 'select … from memories where scope = $1', calls: 600, totalMs: 4800, meanMs: 8, rows: 30000, isNew: false },
  { queryid: '7',  query: 'insert into memories …', calls: 150, totalMs: 1200, meanMs: 8, rows: 150, isNew: true },
];

const SHARE = { clientMs: 30000, dbMs: 6000, ratio: 0.2 };
const CORRELATION = 'load-abc12345';

const NANO = /^\d+$/;

const trace = () => buildTracePayload({ run: RUN, summary: SUMMARY, agg: AGG, share: SHARE, correlationId: CORRELATION });
const metrics = () => buildMetricsPayload({
  run: RUN, summary: SUMMARY, agg: AGG, queryDiff: QUERY_DIFF, share: SHARE, timeMs: RUN.endMs,
});

const attrsOf = (el) => Object.fromEntries(el.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

test('trace: ONE root span, not one per request', () => {
  const spans = trace().payload.resourceSpans[0].scopeSpans[0].spans;
  // 20 rps for 2 minutes is 2,400 requests. A span each would bury the real
  // traffic in the same view for no analytical gain — the per-request detail
  // already exists server-side, joined by correlation id.
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'lorekit.load');
  assert.equal(spans[0].parentSpanId, undefined);
});

test('trace: carries the correlation id that joins it to the server side', () => {
  const a = attrsOf(trace().payload.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.equal(a['lorekit.correlation_id'], CORRELATION);
});

test('trace: timestamps are integer nanosecond strings covering the drive phase', () => {
  const [root] = trace().payload.resourceSpans[0].scopeSpans[0].spans;
  assert.match(root.startTimeUnixNano, NANO);
  assert.match(root.endTimeUnixNano, NANO);
  assert.equal(root.startTimeUnixNano, `${RUN.startMs}000000`);
  assert.equal(root.endTimeUnixNano, `${RUN.endMs}000000`);
});

test('trace: a run with 5xx is an ERROR span; a clean run is not', () => {
  // The point of the run was to find out whether the service holds. It did not.
  assert.equal(trace().payload.resourceSpans[0].scopeSpans[0].spans[0].status.code, 2);

  const clean = buildTracePayload({
    run: RUN, summary: SUMMARY, agg: { ...AGG, errors: 0 }, share: SHARE, correlationId: CORRELATION,
  });
  assert.equal(clean.payload.resourceSpans[0].scopeSpans[0].spans[0].status.code, 1);
});

test('trace: 429s are recorded separately from errors', () => {
  const a = attrsOf(trace().payload.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.equal(a['lorekit.load.rate_limited'], '38');
  assert.equal(a['lorekit.load.errors'], '2');
});

test('trace: names the slowest op on the root, so it reads without drilling', () => {
  const a = attrsOf(trace().payload.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.equal(a['lorekit.load.slowest_op'], 'write', 'p95 400 beats 120');
});

test('metrics: latencies are exported in SECONDS', () => {
  const m = metrics().resourceMetrics[0].scopeMetrics[0].metrics
    .find((x) => x.name === 'lorekit.load.request.duration');
  assert.equal(m.unit, 's');
  const p95Write = m.gauge.dataPoints.find((p) => {
    const a = attrsOf(p);
    return a.op === 'write' && a.quantile === 'p95';
  });
  assert.ok(Math.abs(p95Write.asDouble - 0.4) < 1e-9, `400 ms is 0.4 s, got ${p95Write.asDouble}`);
});

test('metrics: outcome is a bounded vocabulary and zero counts are omitted', () => {
  const m = metrics().resourceMetrics[0].scopeMetrics[0].metrics
    .find((x) => x.name === 'lorekit.load.requests');
  const outcomes = new Set(m.gauge.dataPoints.map((p) => attrsOf(p).outcome));
  for (const o of outcomes) {
    assert.ok(['ok', 'rate_limited', 'client_error', 'error'].includes(o), `unexpected outcome ${o}`);
  }
  // `write` had 0 errors and 0 client errors — neither should appear as a zero.
  const writeOutcomes = m.gauge.dataPoints.filter((p) => attrsOf(p).op === 'write').map((p) => attrsOf(p).outcome);
  assert.deepEqual(writeOutcomes.sort(), ['ok', 'rate_limited']);
});

test('metrics: db time is per statement, bounded, and in seconds', () => {
  const m = metrics().resourceMetrics[0].scopeMetrics[0].metrics
    .find((x) => x.name === 'lorekit.load.db.time');
  assert.equal(m.unit, 's');
  const top = m.gauge.dataPoints[0];
  assert.ok(Math.abs(top.asDouble - 4.8) < 1e-9, '4800 ms is 4.8 s');
  assert.equal(attrsOf(top)['db.queryid'], '-42', 'queryid stays a string — it is an int64');
});

test('metrics: an over-long statement is truncated to 512 chars', () => {
  const long = [{ queryid: '1', query: 'x'.repeat(2000), calls: 1, totalMs: 1, meanMs: 1, rows: 0 }];
  const m = buildMetricsPayload({ run: RUN, summary: SUMMARY, agg: AGG, queryDiff: long, share: SHARE, timeMs: 1 })
    .resourceMetrics[0].scopeMetrics[0].metrics.find((x) => x.name === 'lorekit.load.db.time');
  assert.equal(attrsOf(m.gauge.dataPoints[0])['db.query.text'].length, 512);
});

test('metrics: every datapoint is well-formed', () => {
  for (const m of metrics().resourceMetrics[0].scopeMetrics[0].metrics) {
    assert.ok(m.gauge, `${m.name} must be a gauge`);
    assert.ok(m.unit && m.description, `${m.name} must declare unit and description`);
    assert.ok(m.gauge.dataPoints.length > 0, `${m.name} must not be an empty instrument`);
    for (const p of m.gauge.dataPoints) {
      assert.match(p.timeUnixNano, NANO);
      assert.equal(typeof p.asDouble, 'number');
      assert.ok(Number.isFinite(p.asDouble), `${m.name} value must be finite`);
    }
  }
});

test('metrics: no db metrics when attribution was unavailable', () => {
  // A project without pg_stat_statements still produces client percentiles;
  // the db metrics must simply be absent rather than present-and-empty.
  const names = buildMetricsPayload({ run: RUN, summary: SUMMARY, agg: AGG, queryDiff: [], share: null, timeMs: 1 })
    .resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
  assert.ok(!names.includes('lorekit.load.db.time'));
  assert.ok(!names.includes('lorekit.load.db.share'));
  assert.ok(names.includes('lorekit.load.request.duration'), 'the client-side half still exports');
});

test('resource: synthetic, named `load`, and attributable to a commit', () => {
  for (const r of [trace().payload.resourceSpans[0], metrics().resourceMetrics[0]]) {
    const a = Object.fromEntries(r.resource.attributes.map((x) => [x.key, x.value.stringValue]));
    assert.equal(a['deployment.environment.name'], 'test');
    assert.equal(a['service.name'], 'load', 'its own component, never mixed into api/cli/web/mcp');
    assert.equal(a['service.namespace'], 'lorekit');
    assert.ok(a['service.version']);
  }
});

test('resource: traces and metrics describe the SAME resource', () => {
  assert.deepEqual(
    trace().payload.resourceSpans[0].resource.attributes.map((a) => a.key).sort(),
    metrics().resourceMetrics[0].resource.attributes.map((a) => a.key).sort(),
  );
});

// ── caller dimensions and the stress ladder ─────────────────────────────────

/**
 * The load exporter shipped with NO surface/auth dimension, so a REST run and an
 * MCP run were the same series — they averaged together silently, which is the
 * one comparison the harness exists to make. These pin both halves: the span AND
 * every datapoint, because a dimension on the trace alone cannot filter a metric.
 */

const MCP_RUN = { target: 'preview', surface: 'mcp', authTier: 'token', rps: 20, durationSec: 60, users: 10, startMs: 1_700_000_000_000, endMs: 1_700_000_060_000 };
const MCP_SUMMARY = [{ op: 'list', count: 10, ok: 9, rateLimited: 1, clientErrors: 0, errors: 0, p50: 100, p95: 200, p99: 300, max: 300 }];
const MCP_AGG = { requests: 10, ok: 9, rateLimited: 1, errors: 0, p50: 100, p95: 200, p99: 300 };
const LADDER = [
  { requestedRps: 20, achievedRps: 19.8, count: 100, ok: 100, errors: 0, rateLimited: 0, p50: 100, p99: 300, stopped: false },
  { requestedRps: 40, achievedRps: 39.5, count: 200, ok: 200, errors: 0, rateLimited: 0, p50: 120, p99: 400, stopped: false },
  { requestedRps: 80, achievedRps: 44.0, count: 400, ok: 390, errors: 10, rateLimited: 0, p50: 900, p99: 4000, stopped: true, reason: 'error rate 2.5% > 1.0%' },
];

test('the caller dimensions are on the root span', () => {
  const { payload } = buildTracePayload({ run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, share: null, correlationId: 'load-x' });
  const a = attrsOf(payload.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.equal(a['lorekit.load.surface'], 'mcp');
  assert.equal(a['lorekit.load.auth_tier'], 'token');
});

test('EVERY datapoint carries them too — a span-only dimension cannot filter a metric', () => {
  const env = buildMetricsPayload({
    run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG,
    queryDiff: [{ queryid: '1', query: 'select 1', totalMs: 5 }],
    share: { clientMs: 100, dbMs: 5, ratio: 0.05 }, timeMs: 1_700_000_060_000, ladder: LADDER,
  });
  const points = env.resourceMetrics[0].scopeMetrics[0].metrics.flatMap((m) => m.gauge.dataPoints);
  assert.ok(points.length > 0);
  for (const pt of points) {
    const a = attrsOf(pt);
    assert.equal(a['lorekit.load.surface'], 'mcp', `a datapoint is missing the surface: ${JSON.stringify(a)}`);
    assert.equal(a['lorekit.load.auth_tier'], 'token');
  }
});

test('the dimensions default to the real pairing when unset', () => {
  // An older caller that passes no surface must still land somewhere honest,
  // not in an unlabelled series.
  const env = buildMetricsPayload({ run: { target: 'preview' }, summary: MCP_SUMMARY, agg: MCP_AGG, queryDiff: [], share: null, timeMs: 1 });
  const a = attrsOf(env.resourceMetrics[0].scopeMetrics[0].metrics.flatMap((m) => m.gauge.dataPoints)[0]);
  assert.equal(a['lorekit.load.surface'], 'rest');
  assert.equal(a['lorekit.load.auth_tier'], 'jwt');
});

test('a single-rung run emits NO rung spans and no ladder metrics', () => {
  // The plain load test must not grow a phantom one-rung ladder.
  const { payload } = buildTracePayload({ run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, share: null, correlationId: 'c', ladder: [LADDER[0]] });
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length, 1);
  const env = buildMetricsPayload({ run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, queryDiff: [], share: null, timeMs: 1, ladder: [LADDER[0]] });
  const names = env.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
  assert.ok(!names.some((n) => n.includes('rung')), names.join(','));
  assert.ok(!names.includes('lorekit.load.max_sustained_rps'));
});

test('a ladder emits one child span per rung, parented to the root', () => {
  const { payload } = buildTracePayload({ run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, share: null, correlationId: 'c', ladder: LADDER });
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 4, 'root + 3 rungs');
  const rungs = spans.slice(1);
  for (const r of rungs) {
    assert.equal(r.name, 'lorekit.load.rung');
    assert.equal(r.parentSpanId, spans[0].spanId);
    assert.equal(r.traceId, spans[0].traceId);
  }
  // The rung that ended the ladder says WHY — the most useful attribute here.
  const last = attrsOf(rungs[2]);
  assert.equal(last['lorekit.load.rung.stopped'], true);
  assert.match(String(last['lorekit.load.rung.stop_reason']), /error rate/);
  assert.equal(rungs[2].status.code, 2, 'a rung with errors is an ERROR span');
  assert.equal(rungs[0].status.code, 1);
});

test('the ladder is a queryable series keyed by rps, and reports the headline', () => {
  const env = buildMetricsPayload({ run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, queryDiff: [], share: null, timeMs: 1, ladder: LADDER });
  const byName = Object.fromEntries(env.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => [m.name, m]));

  const dur = byName['lorekit.load.rung.duration'];
  assert.equal(dur.gauge.dataPoints.length, 6, '3 rungs x p50/p99');
  assert.equal(dur.unit, 's');
  assert.equal(dur.gauge.dataPoints[0].asDouble, 0.1, 'ms converted to seconds');
  // STRINGS, deliberately: proto3 JSON renders int64 as a string and a bare
  // number is the classic silent OTLP 400. Pinned so nobody "fixes" it.
  assert.deepEqual([...new Set(dur.gauge.dataPoints.map((pt) => attrsOf(pt).rps))].sort((a, b) => a - b), ['20', '40', '80']);

  // 80 stopped, so the highest that PASSED is 40.
  const head = byName['lorekit.load.max_sustained_rps'].gauge.dataPoints;
  assert.equal(head.length, 1);
  assert.equal(head[0].asDouble, 40);
});

test('max_sustained_rps is 0 when the first rung already failed', () => {
  // Never absent and never the requested rate — a stress run that saturated
  // immediately must report zero, not look like it succeeded.
  const env = buildMetricsPayload({
    run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, queryDiff: [], share: null, timeMs: 1,
    ladder: [{ ...LADDER[0], stopped: true, reason: 'p99' }, { ...LADDER[1], stopped: true, reason: 'p99' }],
  });
  const head = env.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === 'lorekit.load.max_sustained_rps');
  assert.equal(head.gauge.dataPoints[0].asDouble, 0);
});

test('the root span carries the ladder headline so it needs no drill-down', () => {
  const { payload } = buildTracePayload({ run: MCP_RUN, summary: MCP_SUMMARY, agg: MCP_AGG, share: null, correlationId: 'c', ladder: LADDER });
  const a = attrsOf(payload.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.equal(a['lorekit.load.ramp'], true);
  assert.equal(a['lorekit.load.rungs'], '3', 'int64 attributes are strings by OTLP contract');
  assert.equal(a['lorekit.load.max_sustained_rps'], '40');
});
