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
