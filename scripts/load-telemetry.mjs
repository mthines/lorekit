/**
 * Ship a load-test run to Dash0 as OTLP traces + metrics.
 *
 * Sibling of `sweep-telemetry.mjs`; both build on `otlp-export.mjs`, so the
 * resource identity, attribute encoding and POST are shared rather than
 * duplicated — a metric on a different resource than its spans silently stops
 * correlating.
 *
 * WHAT IT EMITS
 *
 * Traces — one root `lorekit.load` span covering the drive phase, with real
 * timestamps. No span per request: at 20 rps for two minutes that is 2,400
 * spans of a synthetic client hammering an endpoint, which buries the real
 * traffic in the same view for no analytical gain. The per-request detail is
 * already in Dash0 from the SERVER side, correlated by
 * `lorekit.correlation_id`, which is the copy worth having.
 *
 * Metrics — gauges, stamped at the run's end:
 *   lorekit.load.request.duration  s        {op, quantile}
 *   lorekit.load.requests          {request} {op, outcome}
 *   lorekit.load.db.time           s        {queryid} — top statements by delta
 *   lorekit.load.db.share          1        db exec time ÷ client wall time
 * Gauges because each is a measurement of one run at one commit, not something
 * that accumulates.
 *
 * `lorekit.correlation_id` on the root span is the join key: the same value
 * rides on every request as `X-LoreKit-Correlation-Id`, so a run's server-side
 * spans and its `usage_events` rows can both be scoped to it.
 */

import { resolveTelemetryConfig, randHex } from '../packages/cli/src/telemetry.mjs';
import {
  SPAN_KIND_INTERNAL,
  gauge,
  gaugeMetric,
  metricsEnvelope,
  post,
  spansEnvelope,
  toOtlpAttributes,
  toUnixNano,
} from './otlp-export.mjs';

const SERVICE_NAME = 'load';

/** How many statements from the query-stats delta to export. Bounded: each is a series. */
const TOP_STATEMENTS = 20;

function buildTracePayload({ run, summary, agg, share, correlationId }) {
  const traceId = randHex(16);
  const spanId = randHex(8);

  const root = {
    traceId,
    spanId,
    name: 'lorekit.load',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(run.startMs),
    endTimeUnixNano: toUnixNano(run.endMs),
    attributes: toOtlpAttributes({
      // The join key to the server side of this same run.
      'lorekit.correlation_id': correlationId,
      'lorekit.load.target': run.target,
      'lorekit.load.rps': run.rps,
      'lorekit.load.duration_s': run.durationSec,
      'lorekit.load.users': run.users,
      'lorekit.load.requests': agg.requests,
      'lorekit.load.ok': agg.ok,
      // Broken out from errors on purpose: a 429 is the rate limiter working.
      'lorekit.load.rate_limited': agg.rateLimited,
      'lorekit.load.errors': agg.errors,
      'lorekit.load.p50_ms': agg.p50 ?? undefined,
      'lorekit.load.p95_ms': agg.p95 ?? undefined,
      'lorekit.load.p99_ms': agg.p99 ?? undefined,
      'lorekit.load.db_share': share ? Number(share.ratio.toFixed(4)) : undefined,
      // The slowest op, on the root so it is visible without drilling.
      'lorekit.load.slowest_op': [...summary].sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))[0]?.op,
    }),
    // A run that produced 5xx is an ERROR span: the whole point was to find out
    // whether the service holds, and it did not.
    status: agg.errors > 0 ? { code: 2, message: `${agg.errors} failed requests` } : { code: 1 },
  };

  return { payload: spansEnvelope(SERVICE_NAME, [root]), traceId };
}

function buildMetricsPayload({ run, summary, agg, queryDiff, share, timeMs }) {
  const durationPoints = [];
  for (const row of summary) {
    for (const [q, v] of [['p50', row.p50], ['p95', row.p95], ['p99', row.p99]]) {
      // Seconds, matching every other duration LoreKit emits.
      if (v !== null && v !== undefined) durationPoints.push(gauge({ op: row.op, quantile: q }, v / 1000, timeMs));
    }
  }

  const outcomePoints = [];
  for (const row of summary) {
    // A bounded outcome vocabulary, so this stays a low-cardinality dimension.
    for (const [outcome, n] of [
      ['ok', row.ok],
      ['rate_limited', row.rateLimited],
      ['client_error', row.clientErrors],
      ['error', row.errors],
    ]) {
      if (n > 0) outcomePoints.push(gauge({ op: row.op, outcome }, n, timeMs));
    }
  }

  const metrics = [
    gaugeMetric({
      name: 'lorekit.load.request.duration',
      unit: 's',
      description: 'Client-observed latency per op, successful requests only.',
      points: durationPoints,
    }),
    gaugeMetric({
      name: 'lorekit.load.requests',
      unit: '{request}',
      description: 'Requests by op and outcome. `rate_limited` is the guardrail working, not a failure.',
      points: outcomePoints,
    }),
    gaugeMetric({
      name: 'lorekit.load.db.time',
      unit: 's',
      description: 'Server-side exec time attributable to THIS run, per statement shape.',
      points: queryDiff.slice(0, TOP_STATEMENTS).map((r) => gauge(
        {
          'db.queryid': r.queryid,
          // Bounded the same way the profiling function bounds it.
          'db.query.text': (r.query ?? '').slice(0, 512),
          'db.system': 'postgresql',
        },
        r.totalMs / 1000,
        timeMs,
      )),
    }),
    gaugeMetric({
      name: 'lorekit.load.db.share',
      unit: '1',
      description: 'Database exec time divided by client wall time. Above 1 means concurrency, not an error.',
      points: share ? [gauge({ target: run.target }, share.ratio, timeMs)] : [],
    }),
  ];

  return metricsEnvelope(SERVICE_NAME, metrics);
}

/**
 * Export one load run. Never throws — a run that lost its telemetry has still
 * produced a result worth printing.
 */
export async function exportLoad({ run, summary, agg, queryDiff, share, correlationId, dryRun }, env = process.env) {
  const timeMs = Date.now();
  const build = () => ({
    traces: buildTracePayload({ run, summary, agg, share, correlationId }),
    metrics: buildMetricsPayload({ run, summary, agg, queryDiff, share, timeMs }),
  });

  // Before resolving a credential, so it works with no token — which is when
  // you most need to inspect what would have been sent.
  if (dryRun) {
    const { traces, metrics } = build();
    return { exported: false, dryRun: true, traces: traces.payload, metrics };
  }

  const cfg = resolveTelemetryConfig(env);
  if (!cfg.enabled) return { exported: false, reason: cfg.reason };

  const { traces, metrics } = build();
  const [t, m] = await Promise.all([
    post(`${cfg.endpoint}/v1/traces`, cfg.headers, traces.payload),
    post(`${cfg.endpoint}/v1/metrics`, cfg.headers, metrics),
  ]);

  return {
    exported: t.ok && m.ok,
    traceId: traces.traceId,
    endpoint: cfg.endpoint,
    datapoints: metrics.resourceMetrics[0].scopeMetrics[0].metrics
      .reduce((n, x) => n + x.gauge.dataPoints.length, 0),
    errors: [t.error, m.error].filter(Boolean),
  };
}

export { buildTracePayload, buildMetricsPayload };
