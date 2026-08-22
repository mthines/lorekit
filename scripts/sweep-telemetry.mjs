/**
 * Ship a row-scaling sweep run to Dash0 as OTLP traces + metrics.
 *
 * WHY
 * ---
 * A terminal table answers "how slow is it" once. The question that actually
 * matters is "did the index help" — and that needs two runs side by side, on
 * named commits, months apart. So every run is exported: the numbers become a
 * time series, and a regression is visible rather than remembered.
 *
 * WHAT IT EMITS, AND WHY EACH SIGNAL IS THAT SIGNAL
 * -------------------------------------------------
 * Traces — one root span per run, one child per rung, with REAL timestamps
 * taken from `sweep_phases`. Deliberately NOT one span per probe: a probe's
 * p50 is an aggregate over 25 repetitions, not an interval, so a span for it
 * would have to invent a start and an end. Aggregates belong in metrics.
 *
 * Metrics — gauges, all stamped at the run's end:
 *   lorekit.sweep.probe.duration   s    {probe, rows, quantile}
 *   lorekit.sweep.growth_factor    1    {probe}   p50(max rung) / p50(min rung)
 *   lorekit.sweep.index.bytes      By   {index}
 *   lorekit.sweep.rows             1    {kind: total|focal}
 * Gauges rather than sums because each is a MEASUREMENT AT A POINT IN TIME
 * (this run, this commit) — not something that accumulates. One point per run
 * per series gives exactly the run-over-run comparison this exists for.
 *
 * The plan's top node type rides on the rung span as `db.plan.node_type`.
 * "Seq Scan" becoming "Index Only Scan" is the entire signal an index change
 * is meant to produce, and as an attribute it is one low-cardinality
 * dimension instead of a diff over plan text.
 *
 * RESOURCE IDENTITY
 * -----------------
 * `service.name=sweep` — its own component, so benchmark numbers never mix
 * into `api`/`cli`/`web`/`mcp` dashboards. `deployment.environment.name=test`
 * always: this is synthetic traffic by construction and must never land in a
 * production view. `vcs.ref.head.revision` comes from git, which is what makes
 * a run attributable to the commit it measured — without it the time series is
 * a row of numbers nobody can bisect.
 *
 * The OTLP endpoint, token and dataset are resolved by the CLI's
 * `resolveTelemetryConfig` rather than re-derived here: it already owns the
 * token priority (`OTEL_EXPORTER_OTLP_HEADERS` > `LOREKIT_TELEMETRY_TOKEN` >
 * baked-in), the `Dash0-Dataset` precedence and the opt-out signals
 * (`LOREKIT_TELEMETRY`, `DO_NOT_TRACK`). A second copy of that logic is how a
 * benchmark ends up in the wrong dataset, or exporting when someone opted out.
 */

import { spawnSync } from 'node:child_process';

import { resolveTelemetryConfig, randHex } from '../packages/cli/src/telemetry.mjs';

const SERVICE_NAME = 'sweep';

// OTLP span kinds. A benchmark harness calls nothing on anyone's behalf, so
// every span here is INTERNAL.
const SPAN_KIND_INTERNAL = 1;

function toOtlpValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: String(v) };
}

const toOtlpAttributes = (attrs) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: toOtlpValue(value) }));

const toUnixNano = (ms) => `${Math.round(ms)}000000`;

/** The commit a run measured. Absent outside a git checkout — omitted, never faked. */
function gitRevision() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

function gitBranch() {
  const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const name = res.status === 0 ? res.stdout.trim() : '';
  return name && name !== 'HEAD' ? name : undefined;
}

function resourceAttributes(meta) {
  const revision = gitRevision();
  const branch = gitBranch();
  return toOtlpAttributes({
    'service.name': SERVICE_NAME,
    'service.namespace': 'lorekit',
    'service.version': revision ?? 'unknown',
    // Always `test`. A benchmark is synthetic by construction, and this is the
    // one value the edge's own header allowlist admits for the same reason.
    'deployment.environment.name': 'test',
    'vcs.repository.name': 'mthines/lorekit',
    'vcs.ref.head.revision': revision,
    'vcs.ref.head.name': branch,
    'vcs.ref.head.type': branch ? 'branch' : undefined,
    'db.system': 'postgresql',
    'db.version': meta.pg_version,
  });
}

/**
 * Build the trace: a root span for the run, a child per rung.
 *
 * Rung spans use the real `started_at`/`ended_at` recorded by the SQL, so the
 * waterfall shows where the time actually went — which at the larger rungs is
 * mostly seeding, and worth seeing rather than hiding.
 */
function buildTracePayload({ meta, phases, plans, growth, config, runId }) {
  const traceId = randHex(16);
  const rootSpanId = randHex(8);

  const startMs = phases.length
    ? Math.min(...phases.map((p) => Date.parse(p.started_at)))
    : Date.now();
  const endMs = phases.length
    ? Math.max(...phases.map((p) => Date.parse(p.ended_at ?? p.started_at)))
    : Date.now();

  // Plans are captured only at the top rung, keyed by probe.
  const planByProbe = new Map(plans.map((p) => [p.probe, p]));
  const growthByProbe = new Map(growth.map((g) => [g.probe, g]));

  const rootSpan = {
    traceId,
    spanId: rootSpanId,
    name: 'lorekit.sweep',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(startMs),
    endTimeUnixNano: toUnixNano(endMs),
    attributes: toOtlpAttributes({
      'lorekit.sweep.run_id': runId,
      'lorekit.sweep.rungs': config.rungs,
      'lorekit.sweep.users': Number(config.users),
      'lorekit.sweep.background_rows': Number(config.backgroundRows),
      'lorekit.sweep.iterations': Number(config.iterations),
      'lorekit.sweep.rows_total': Number(meta.rows_total),
      'lorekit.sweep.focal_rows': Number(meta.focal_rows),
      'lorekit.sweep.table_bytes': Number(meta.table_bytes),
      'lorekit.sweep.indexes_bytes': Number(meta.indexes_bytes),
      // The headline finding, on the root span so it is visible without
      // drilling: how much the cap predicate grew across the sweep.
      'lorekit.sweep.worst_growth_probe': growth[0]?.probe,
      'lorekit.sweep.worst_growth_x': growth[0] ? Number(growth[0].growth_x) : undefined,
    }),
    status: { code: 1 },
  };

  const rungSpans = phases.map((phase) => {
    const capPlan = planByProbe.get('cap_count (trigger predicate)');
    const orgPlan = planByProbe.get('cap_count (org branch, indexed)');
    const isTopRung = Number(phase.rung) === Number(meta.focal_rows)
      || Number(phase.rung) === Math.max(...phases.map((p) => Number(p.rung)));
    return {
      traceId,
      spanId: randHex(8),
      parentSpanId: rootSpanId,
      name: `lorekit.sweep.rung`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(Date.parse(phase.started_at)),
      endTimeUnixNano: toUnixNano(Date.parse(phase.ended_at ?? phase.started_at)),
      attributes: toOtlpAttributes({
        'lorekit.sweep.rows': Number(phase.rung),
        // Plans are captured once, at the top rung — attach them only there
        // rather than repeating the top rung's plan on every rung, which would
        // read as if each rung had been explained.
        'db.plan.node_type': isTopRung ? capPlan?.node_type : undefined,
        'db.plan.node_type.org_branch': isTopRung ? orgPlan?.node_type : undefined,
        'lorekit.sweep.cap_count_growth_x':
          growthByProbe.get('cap_count (trigger predicate)')?.growth_x !== undefined
            ? Number(growthByProbe.get('cap_count (trigger predicate)').growth_x)
            : undefined,
      }),
      status: { code: 1 },
    };
  });

  return {
    payload: {
      resourceSpans: [{
        resource: { attributes: resourceAttributes(meta) },
        scopeSpans: [{
          scope: { name: `lorekit-${SERVICE_NAME}`, version: '1.0.0' },
          spans: [rootSpan, ...rungSpans],
        }],
      }],
    },
    traceId,
  };
}

/** One gauge datapoint. */
const gauge = (attributes, value, timeMs) => ({
  attributes: toOtlpAttributes(attributes),
  timeUnixNano: toUnixNano(timeMs),
  asDouble: value,
});

function buildMetricsPayload({ meta, timings, growth, indexes, timeMs }) {
  const metrics = [];

  // Probe durations. Seconds, not milliseconds, to match every other duration
  // LoreKit emits (`lorekit.tool.duration`, `lorekit.db.query.time`) — a
  // benchmark that reported ms would be the one series nobody could compare
  // against the rest.
  const durationPoints = [];
  for (const row of timings) {
    durationPoints.push(gauge(
      { probe: row.probe, rows: Number(row.rung), quantile: 'p50' },
      Number(row.p50_ms) / 1000, timeMs,
    ));
    durationPoints.push(gauge(
      { probe: row.probe, rows: Number(row.rung), quantile: 'p95' },
      Number(row.p95_ms) / 1000, timeMs,
    ));
  }
  if (durationPoints.length) {
    metrics.push({
      name: 'lorekit.sweep.probe.duration',
      unit: 's',
      description: 'Probe latency at a given focal-user row count.',
      gauge: { dataPoints: durationPoints },
    });
  }

  const growthPoints = growth
    .filter((g) => g.growth_x !== null && g.growth_x !== undefined)
    .map((g) => gauge({ probe: g.probe }, Number(g.growth_x), timeMs));
  if (growthPoints.length) {
    metrics.push({
      name: 'lorekit.sweep.growth_factor',
      unit: '1',
      description: 'p50 at the largest rung divided by p50 at the smallest. ~1 is indexed.',
      gauge: { dataPoints: growthPoints },
    });
  }

  const indexPoints = indexes.map((i) => gauge({ index: i.index_name }, Number(i.bytes), timeMs));
  if (indexPoints.length) {
    metrics.push({
      name: 'lorekit.sweep.index.bytes',
      unit: 'By',
      description: 'On-disk size per index on `memories` at the end of the run.',
      gauge: { dataPoints: indexPoints },
    });
  }

  metrics.push({
    name: 'lorekit.sweep.rows',
    unit: '1',
    description: 'Row counts the run finished at.',
    gauge: {
      dataPoints: [
        gauge({ kind: 'total' }, Number(meta.rows_total), timeMs),
        gauge({ kind: 'focal' }, Number(meta.focal_rows), timeMs),
      ],
    },
  });

  return {
    resourceMetrics: [{
      resource: { attributes: resourceAttributes(meta) },
      scopeMetrics: [{
        scope: { name: `lorekit-${SERVICE_NAME}`, version: '1.0.0' },
        metrics,
      }],
    }],
  };
}

async function post(url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status}${body ? ` ${body.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Export one sweep run. Never throws: a benchmark that fails because its
 * telemetry could not be shipped has lost the result it just spent minutes
 * computing. Returns a report the caller prints.
 *
 * @param {object} results  the JSON the runner read out of the sweep tables
 * @param {object} config   the run's parameters, for span attributes
 * @param {object} [env]    defaults to process.env
 */
export async function exportSweep(results, config, env = process.env) {
  const meta = Object.fromEntries((results.meta ?? []).map((r) => [r.key, r.value]));

  // `--dry-run` builds the payloads and returns them WITHOUT resolving a
  // credential or opening a socket. It exists because an OTLP rejection is a
  // bare 400 from the ingress: being able to hand someone the exact bytes that
  // were going to be sent turns "the export failed" into a diffable artifact.
  // Deliberately before the config resolution, so it works with no token at
  // all — which is the situation you are in when you most need it.
  if (config.dryRun) {
    const { payload: tracePayload } = buildTracePayload({
      meta,
      phases: results.phases ?? [],
      plans: results.plans ?? [],
      growth: results.growth ?? [],
      config,
      runId: `sweep-${randHex(6)}`,
    });
    return {
      exported: false,
      dryRun: true,
      traces: tracePayload,
      metrics: buildMetricsPayload({
        meta,
        timings: results.timings ?? [],
        growth: results.growth ?? [],
        indexes: results.indexes ?? [],
        timeMs: Date.now(),
      }),
    };
  }

  const cfg = resolveTelemetryConfig(env);
  if (!cfg.enabled) return { exported: false, reason: cfg.reason };

  const runId = `sweep-${randHex(6)}`;
  const timeMs = Date.now();

  const { payload: tracePayload, traceId } = buildTracePayload({
    meta,
    phases: results.phases ?? [],
    plans: results.plans ?? [],
    growth: results.growth ?? [],
    config,
    runId,
  });
  const metricsPayload = buildMetricsPayload({
    meta,
    timings: results.timings ?? [],
    growth: results.growth ?? [],
    indexes: results.indexes ?? [],
    timeMs,
  });

  const [traces, metrics] = await Promise.all([
    post(`${cfg.endpoint}/v1/traces`, cfg.headers, tracePayload, 10_000),
    post(`${cfg.endpoint}/v1/metrics`, cfg.headers, metricsPayload, 10_000),
  ]);

  return {
    exported: traces.ok && metrics.ok,
    runId,
    traceId,
    endpoint: cfg.endpoint,
    datapoints: metricsPayload.resourceMetrics[0].scopeMetrics[0].metrics
      .reduce((n, m) => n + m.gauge.dataPoints.length, 0),
    spans: tracePayload.resourceSpans[0].scopeSpans[0].spans.length,
    errors: [traces.error, metrics.error].filter(Boolean),
  };
}

export { buildTracePayload, buildMetricsPayload };
