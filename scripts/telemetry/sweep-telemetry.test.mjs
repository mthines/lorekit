import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTracePayload, buildMetricsPayload } from './sweep-telemetry.mjs';

/**
 * OTLP payload-shape tests for the sweep exporter.
 *
 * These exist because the failure mode is SILENT and remote: a malformed OTLP
 * body is a 400 from the ingress, and the only symptom is a dashboard that
 * never gains a datapoint. The sweep is run rarely, so nobody would notice for
 * weeks. Everything asserted below is a rule the OTLP/JSON encoding imposes and
 * that a hand-built payload can violate while still looking correct:
 *
 *   * timestamps are integer NANOSECOND strings, not ms and not numbers
 *   * a gauge datapoint carries `asDouble`, and attributes are {key, value}
 *     pairs with a typed value — never a plain object
 *   * every span shares one traceId, and children point at the root
 *   * `deployment.environment.name` is always `test`, so a benchmark can never
 *     land in a production view
 */

const META = [
  { key: 'rows_total', value: '106000' },
  { key: 'focal_rows', value: '100000' },
  { key: 'table_bytes', value: '123456789' },
  { key: 'indexes_bytes', value: '87654321' },
  { key: 'pg_version', value: '16.13' },
];

const PHASES = [
  { rung: 1000, started_at: '2026-08-22T10:00:00.000Z', ended_at: '2026-08-22T10:00:05.000Z' },
  { rung: 100000, started_at: '2026-08-22T10:00:05.000Z', ended_at: '2026-08-22T10:01:00.000Z' },
];

const TIMINGS = [
  { probe: 'cap_count (trigger predicate)', rung: 1000, p50_ms: 0.251, p95_ms: 0.291 },
  { probe: 'cap_count (trigger predicate)', rung: 100000, p50_ms: 43.649, p95_ms: 47.213 },
];

const GROWTH = [
  { probe: 'cap_count (trigger predicate)', from_rows: 1000, to_rows: 100000, growth_x: 173.9 },
  { probe: 'insert (trigger OFF)', from_rows: 1000, to_rows: 100000, growth_x: null },
];

const PLANS = [
  { probe: 'cap_count (trigger predicate)', rung: 100000, node_type: 'Seq Scan' },
  { probe: 'cap_count (org branch, indexed)', rung: 100000, node_type: 'Index Only Scan' },
];

const INDEXES = [{ index_name: 'memories_value_trgm_idx', bytes: 4874240 }];

const CONFIG = { rungs: '1000,100000', users: '3', backgroundRows: '2000', iterations: '25' };

const meta = Object.fromEntries(META.map((r) => [r.key, r.value]));

const buildTrace = () => buildTracePayload({
  meta, phases: PHASES, plans: PLANS, growth: GROWTH, config: CONFIG, runId: 'sweep-abc123',
});

const buildMetrics = () => buildMetricsPayload({
  meta, timings: TIMINGS, growth: GROWTH, indexes: INDEXES, timeMs: Date.parse('2026-08-22T10:01:00Z'),
});

const NANO = /^\d+$/;

test('trace: one trace, root plus a span per rung, children parented correctly', () => {
  const { payload, traceId } = buildTrace();
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;

  assert.equal(spans.length, 1 + PHASES.length);
  assert.ok(spans.every((s) => s.traceId === traceId), 'every span shares the traceId');

  const [root, ...children] = spans;
  assert.equal(root.name, 'lorekit.sweep');
  assert.equal(root.parentSpanId, undefined, 'the root has no parent');
  assert.ok(children.every((c) => c.parentSpanId === root.spanId), 'children point at the root');
  assert.equal(new Set(spans.map((s) => s.spanId)).size, spans.length, 'span ids are unique');
});

test('trace: timestamps are integer nanosecond strings spanning the run', () => {
  const spans = buildTrace().payload.resourceSpans[0].scopeSpans[0].spans;
  for (const s of spans) {
    assert.match(s.startTimeUnixNano, NANO, `${s.name} start must be an integer string`);
    assert.match(s.endTimeUnixNano, NANO, `${s.name} end must be an integer string`);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano), 'end is not before start');
  }
  // The root must cover the whole run, not just the first rung.
  const [root] = spans;
  assert.equal(root.startTimeUnixNano, `${Date.parse(PHASES[0].started_at)}000000`);
  assert.equal(root.endTimeUnixNano, `${Date.parse(PHASES.at(-1).ended_at)}000000`);
});

test('trace: the plan node type rides on the TOP rung only', () => {
  const spans = buildTrace().payload.resourceSpans[0].scopeSpans[0].spans;
  const attrsOf = (s) => Object.fromEntries(s.attributes.map((a) => [a.key, a.value]));

  const small = attrsOf(spans.find((s) => attrsOf(s)['lorekit.sweep.rows']?.intValue === '1000'));
  const top = attrsOf(spans.find((s) => attrsOf(s)['lorekit.sweep.rows']?.intValue === '100000'));

  assert.equal(top['db.plan.node_type'].stringValue, 'Seq Scan');
  assert.equal(top['db.plan.node_type.org_branch'].stringValue, 'Index Only Scan');
  // Repeating the top rung's plan on every rung would read as if each rung had
  // been explained, which it was not.
  assert.equal(small['db.plan.node_type'], undefined);
});

test('trace: the headline finding is on the root span', () => {
  const [root] = buildTrace().payload.resourceSpans[0].scopeSpans[0].spans;
  const attrs = Object.fromEntries(root.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs['lorekit.sweep.worst_growth_probe'].stringValue, 'cap_count (trigger predicate)');
  assert.equal(attrs['lorekit.sweep.worst_growth_x'].doubleValue, 173.9);
  assert.equal(attrs['lorekit.sweep.run_id'].stringValue, 'sweep-abc123');
});

test('metrics: durations are exported in SECONDS', () => {
  const metrics = buildMetrics().resourceMetrics[0].scopeMetrics[0].metrics;
  const duration = metrics.find((m) => m.name === 'lorekit.sweep.probe.duration');
  assert.equal(duration.unit, 's', 'must match every other LoreKit duration');

  const p50AtTop = duration.gauge.dataPoints.find((p) => {
    const a = Object.fromEntries(p.attributes.map((x) => [x.key, x.value]));
    return a.rows.intValue === '100000' && a.quantile.stringValue === 'p50';
  });
  // 43.649 ms is 0.043649 s. Off by 1000x is invisible on a chart with no
  // reference point, which is why this is pinned.
  assert.ok(Math.abs(p50AtTop.asDouble - 0.043649) < 1e-9, `got ${p50AtTop.asDouble}`);
});

test('metrics: every datapoint is a well-formed gauge point', () => {
  const metrics = buildMetrics().resourceMetrics[0].scopeMetrics[0].metrics;
  assert.ok(metrics.length >= 4, 'duration, growth, index bytes and rows');
  for (const m of metrics) {
    assert.ok(m.gauge, `${m.name} must be a gauge`);
    assert.ok(m.unit, `${m.name} must declare a unit`);
    assert.ok(m.description, `${m.name} must describe itself`);
    for (const p of m.gauge.dataPoints) {
      assert.match(p.timeUnixNano, NANO, `${m.name} timestamp must be an integer string`);
      assert.equal(typeof p.asDouble, 'number', `${m.name} value must be a JSON number`);
      assert.ok(Number.isFinite(p.asDouble), `${m.name} value must be finite`);
      for (const a of p.attributes) {
        assert.equal(typeof a.key, 'string');
        // A typed AnyValue, never a bare JS value.
        assert.ok(
          'stringValue' in a.value || 'intValue' in a.value || 'doubleValue' in a.value || 'boolValue' in a.value,
          `${m.name} attribute ${a.key} must be a typed OTLP value`,
        );
      }
    }
  }
});

test('metrics: a null growth factor is dropped, not exported as NaN', () => {
  // `insert (trigger OFF)` has growth_x null in the fixture (a divide by zero
  // guard upstream). NaN would be rejected by the ingress or, worse, silently
  // become a zero on the chart.
  const growth = buildMetrics().resourceMetrics[0].scopeMetrics[0].metrics
    .find((m) => m.name === 'lorekit.sweep.growth_factor');
  const probes = growth.gauge.dataPoints.map(
    (p) => Object.fromEntries(p.attributes.map((a) => [a.key, a.value])).probe.stringValue,
  );
  assert.deepEqual(probes, ['cap_count (trigger predicate)']);
});

test('resource: a benchmark is always synthetic and never anonymous', () => {
  for (const payload of [buildTrace().payload.resourceSpans[0], buildMetrics().resourceMetrics[0]]) {
    const attrs = Object.fromEntries(payload.resource.attributes.map((a) => [a.key, a.value.stringValue]));
    // Never a production view, whatever the ambient environment says.
    assert.equal(attrs['deployment.environment.name'], 'test');
    // Its own component, so benchmark numbers never mix into api/cli/web/mcp.
    assert.equal(attrs['service.name'], 'sweep');
    assert.equal(attrs['service.namespace'], 'lorekit');
    // Without a revision the time series is a row of numbers nobody can bisect.
    assert.ok(attrs['service.version'], 'service.version carries the commit');
  }
});

test('resource: traces and metrics describe the SAME resource', () => {
  // A metric on a different resource than its spans silently stops correlating
  // — the same invariant `otlp-metrics.ts` holds on the edge.
  const traceAttrs = buildTrace().payload.resourceSpans[0].resource.attributes;
  const metricAttrs = buildMetrics().resourceMetrics[0].resource.attributes;
  assert.deepEqual(
    traceAttrs.map((a) => a.key).sort(),
    metricAttrs.map((a) => a.key).sort(),
  );
});

test('empty results do not throw or emit garbage', () => {
  // A sweep that found nothing (a bad --rungs, a failed seed) must still
  // produce a valid payload rather than crashing the runner after the numbers
  // have already been computed.
  const empty = buildMetricsPayload({ meta: {}, timings: [], growth: [], indexes: [], timeMs: 1 });
  const metrics = empty.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.ok(metrics.every((m) => m.gauge.dataPoints.length > 0), 'no metric with zero datapoints');
  assert.doesNotThrow(() => JSON.stringify(empty));
});
