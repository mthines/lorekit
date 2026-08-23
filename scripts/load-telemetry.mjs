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
 * A STRESS run additionally gets one child span per ladder rung, mirroring
 * `sweep-telemetry.mjs`'s rung spans — the waterfall is where the ladder becomes
 * readable, and the rungs are the experiment rather than an implementation
 * detail of it.
 *
 * Metrics — gauges, stamped at the run's end:
 *   lorekit.load.request.duration  s        {op, quantile}
 *   lorekit.load.requests          {request} {op, outcome}
 *   lorekit.load.db.time           s        {queryid} — top statements by delta
 *   lorekit.load.db.share          1        db exec time ÷ client wall time
 *   lorekit.load.rung.duration     s        {rps, quantile} — the ladder
 *   lorekit.load.max_sustained_rps {request/s}  a stress run's headline
 * Gauges because each is a measurement of one run at one commit, not something
 * that accumulates.
 *
 * EVERY span AND every datapoint carries `lorekit.load.surface` and
 * `lorekit.load.auth_tier`. Not just the span: a dimension present only on the
 * trace cannot filter a metric series, so without them on the datapoints an MCP
 * run and a REST run land in the SAME series and silently average together —
 * which is the one comparison this harness now exists to make. Both are bounded
 * (rest|mcp, jwt|token), so they add no meaningful cardinality.
 *
 * `lorekit.correlation_id` on the root span is the join key: the same value
 * rides on every request as `X-LoreKit-Correlation-Id`, so a run's server-side
 * spans and its `usage_events` rows can both be scoped to it.
 */

import { resolveTelemetryConfig, randHex } from '../packages/cli/src/telemetry/telemetry.mjs';
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

/**
 * The dimensions that identify WHICH CALLER a run simulated.
 *
 * Applied to the root span, every rung span, and every gauge datapoint. A run
 * without them is unattributable: `rest+jwt` (the dashboard), `rest+token` (the
 * CLI) and `mcp+token` (agents) are different code paths with different costs,
 * and averaging them is worse than not measuring — the number looks real.
 */
function surfaceDims(run) {
  return {
    'lorekit.load.surface': run.surface ?? 'rest',
    'lorekit.load.auth_tier': run.authTier ?? (run.surface === 'mcp' ? 'token' : 'jwt'),
  };
}

/** How many statements from the query-stats delta to export. Bounded: each is a series. */
const TOP_STATEMENTS = 20;

function buildTracePayload({ run, summary, agg, share, correlationId, ladder = [] }) {
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
      ...surfaceDims(run),
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
      // Stress-only. `max_sustained_rps` is the answer a ladder was run to get,
      // so it belongs on the root rather than only in the rung detail.
      'lorekit.load.ramp': ladder.length > 1 ? true : undefined,
      'lorekit.load.rungs': ladder.length > 1 ? ladder.length : undefined,
      'lorekit.load.max_sustained_rps': ladder.length > 1
        ? ([...ladder].reverse().find((r) => !r.stopped)?.requestedRps ?? 0)
        : undefined,
    }),
    // A run that produced 5xx is an ERROR span: the whole point was to find out
    // whether the service holds, and it did not.
    status: agg.errors > 0 ? { code: 2, message: `${agg.errors} failed requests` } : { code: 1 },
  };

  // One child per rung. Timestamps are SYNTHETIC here — the rungs ran back to
  // back inside [startMs, endMs] but each rung's own boundaries are not recorded
  // per rung, so they are laid out evenly across the run rather than faked to a
  // precision we do not have. The ORDER and the per-rung measurements are the
  // real content; the widths are indicative.
  const rungSpans = ladder.length > 1
    ? ladder.map((r, i) => {
      const slice = (run.endMs - run.startMs) / ladder.length;
      return {
        traceId,
        spanId: randHex(8),
        parentSpanId: spanId,
        name: 'lorekit.load.rung',
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: toUnixNano(run.startMs + i * slice),
        endTimeUnixNano: toUnixNano(run.startMs + (i + 1) * slice),
        attributes: toOtlpAttributes({
          'lorekit.correlation_id': correlationId,
          ...surfaceDims(run),
          'lorekit.load.rung.requested_rps': r.requestedRps,
          'lorekit.load.rung.achieved_rps': Number(r.achievedRps?.toFixed(2)),
          'lorekit.load.rung.requests': r.count,
          'lorekit.load.rung.ok': r.ok,
          'lorekit.load.rung.rate_limited': r.rateLimited,
          'lorekit.load.rung.errors': r.errors,
          'lorekit.load.rung.p50_ms': r.p50 ?? undefined,
          'lorekit.load.rung.p99_ms': r.p99 ?? undefined,
          // Why the ladder ended here — the single most useful attribute on a
          // stress run, and the one a bare number cannot convey.
          'lorekit.load.rung.stopped': r.stopped || undefined,
          'lorekit.load.rung.stop_reason': r.reason,
        }),
        status: r.errors > 0 ? { code: 2, message: `${r.errors} failed requests` } : { code: 1 },
      };
    })
    : [];

  return { payload: spansEnvelope(SERVICE_NAME, [root, ...rungSpans]), traceId };
}

function buildMetricsPayload({ run, summary, agg, queryDiff, share, timeMs, ladder = [] }) {
  // Every datapoint carries the caller dimensions — see the module header for
  // why the span alone is not enough.
  const dims = surfaceDims(run);
  const durationPoints = [];
  for (const row of summary) {
    for (const [q, v] of [['p50', row.p50], ['p95', row.p95], ['p99', row.p99]]) {
      // Seconds, matching every other duration LoreKit emits.
      if (v !== null && v !== undefined) durationPoints.push(gauge({ ...dims, op: row.op, quantile: q }, v / 1000, timeMs));
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
      if (n > 0) outcomePoints.push(gauge({ ...dims, op: row.op, outcome }, n, timeMs));
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
          ...dims,
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
      points: share ? [gauge({ ...dims, target: run.target }, share.ratio, timeMs)] : [],
    }),
  ];

  // The ladder as a queryable series. `rps` is the experiment's INDEPENDENT
  // variable, so it is a dimension here for the same reason the sweep's `rows`
  // is — this is the x-axis, not incidental cardinality, and it is bounded by
  // the rung count.
  if (ladder.length > 1) {
    const rungPoints = [];
    for (const r of ladder) {
      for (const [q, v] of [['p50', r.p50], ['p99', r.p99]]) {
        if (v !== null && v !== undefined) {
          rungPoints.push(gauge({ ...dims, rps: r.requestedRps, quantile: q }, v / 1000, timeMs));
        }
      }
    }
    const lastGood = [...ladder].reverse().find((r) => !r.stopped);
    metrics.push(
      gaugeMetric({
        name: 'lorekit.load.rung.duration',
        unit: 's',
        description: 'Client-observed latency at each rung of a stress ladder, keyed by requested rps.',
        points: rungPoints,
      }),
      gaugeMetric({
        name: 'lorekit.load.rung.achieved_rps',
        unit: '{request}/s',
        description: 'Rate actually offered at each rung. Below the requested value means the CLIENT saturated.',
        points: ladder.map((r) => gauge({ ...dims, rps: r.requestedRps }, r.achievedRps ?? 0, timeMs)),
      }),
      gaugeMetric({
        name: 'lorekit.load.max_sustained_rps',
        unit: '{request}/s',
        description: 'Highest rung that passed every stop condition — a stress run\'s headline. 0 when the first rung already failed.',
        points: [gauge(dims, lastGood?.requestedRps ?? 0, timeMs)],
      }),
    );
  }

  return metricsEnvelope(SERVICE_NAME, metrics);
}

/**
 * Export one load run. Never throws — a run that lost its telemetry has still
 * produced a result worth printing.
 */
export async function exportLoad({ run, summary, agg, queryDiff, share, correlationId, ladder = [], dryRun }, env = process.env) {
  const timeMs = Date.now();
  const build = () => ({
    traces: buildTracePayload({ run, summary, agg, share, correlationId, ladder }),
    metrics: buildMetricsPayload({ run, summary, agg, queryDiff, share, timeMs, ladder }),
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
