/**
 * The OTLP/JSON encoding shared by LoreKit's benchmark exporters.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `sweep-telemetry.mjs` and `load-telemetry.mjs` ship different SIGNALS (a
 * sweep's rung spans and growth gauges; a load run's request percentiles) but
 * they describe the same kind of thing to the same backend, so the parts below
 * must not be written twice:
 *
 *   * The resource attributes. Two copies is how a metric ends up on a resource
 *     Dash0 treats as a DIFFERENT service from the spans beside it — the
 *     signals silently stop correlating and nothing errors. `_shared/otel.ts`
 *     holds the same invariant on the edge, for the same reason.
 *   * The int64/double split in `toOtlpValue`. proto3 JSON renders int64 as a
 *     STRING, and a bare number is the classic OTLP rejection: a silent 400.
 *   * `deployment.environment.name = test`. A benchmark is synthetic by
 *     construction and must never land in a production view. Hardcoded here so
 *     no caller can pass something else.
 *
 * The endpoint, token and dataset are NOT resolved here — that is the CLI's
 * `resolveTelemetryConfig`, which already owns the token priority, the
 * `Dash0-Dataset` precedence and the opt-out signals. Callers pass its result
 * to `post`.
 */

import { spawnSync } from 'node:child_process';

/** OTLP span kinds. A benchmark harness acts for nobody, so its spans are INTERNAL. */
export const SPAN_KIND_INTERNAL = 1;

/** OTLP `AggregationTemporality`. DELTA = 1; benchmarks emit gauges, not sums. */
export const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

/**
 * Encode a scalar as an OTLP `AnyValue`.
 *
 * The integer branch renders as `intValue` — a STRING, per proto3 JSON's int64
 * mapping. Sending an int64 as a bare JSON number is rejected by the ingress
 * with a 400 that names nothing useful.
 */
export function toOtlpValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: String(v) };
}

/** `{k: v}` → OTLP `[{key, value}]`, dropping null/undefined rather than encoding them. */
export function toOtlpAttributes(attrs) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: toOtlpValue(value) }));
}

/** ms since the epoch → the integer nanosecond STRING OTLP wants. */
export function toUnixNano(ms) {
  // Integer arithmetic on the ms epoch: `ms * 1e6` in floating point loses
  // precision at nanosecond scale, and the field is a string regardless.
  return `${Math.round(ms)}000000`;
}

/** The commit a run measured. Absent outside a git checkout — omitted, never faked. */
export function gitRevision() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** The branch a run measured, or undefined on a detached HEAD. */
export function gitBranch() {
  const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const name = res.status === 0 ? res.stdout.trim() : '';
  return name && name !== 'HEAD' ? name : undefined;
}

/**
 * The `resource.attributes` array every benchmark signal carries.
 *
 * @param serviceName  the harness's own component name (`sweep`, `load`), so
 *   benchmark numbers never mix into `api`/`cli`/`web`/`mcp` dashboards.
 * @param extra        harness-specific resource attributes (e.g. `db.version`).
 *   Datapoint-level dimensions do NOT belong here — a resource attribute
 *   applies to every signal in the payload.
 */
export function resourceAttributes(serviceName, extra = {}) {
  const revision = gitRevision();
  const branch = gitBranch();
  return toOtlpAttributes({
    'service.name': serviceName,
    'service.namespace': 'lorekit',
    'service.version': revision ?? 'unknown',
    // Always `test`, never a parameter. A benchmark is synthetic traffic by
    // construction, and this is the one value the edge's own header allowlist
    // admits for exactly the same reason.
    'deployment.environment.name': 'test',
    'vcs.repository.name': 'mthines/lorekit',
    // Without a revision the run is a number in a time series nobody can
    // bisect, which defeats the point of exporting at all.
    'vcs.ref.head.revision': revision,
    'vcs.ref.head.name': branch,
    'vcs.ref.head.type': branch ? 'branch' : undefined,
    ...extra,
  });
}

/** One gauge datapoint: a measurement at a point in time (this run, this commit). */
export function gauge(attributes, value, timeMs) {
  return {
    attributes: toOtlpAttributes(attributes),
    timeUnixNano: toUnixNano(timeMs),
    asDouble: value,
  };
}

/**
 * Assemble a gauge metric, or `null` when it has no datapoints.
 *
 * Returning null (and letting the caller filter) rather than an empty metric:
 * OTLP accepts a metric with zero datapoints, and it shows up in the backend as
 * a broken instrument that never has data.
 */
export function gaugeMetric({ name, unit, description, points }) {
  if (!points.length) return null;
  return { name, unit, description, gauge: { dataPoints: points } };
}

/**
 * POST an OTLP payload. Never throws — returns `{ok, error}`.
 *
 * A benchmark that died because its telemetry could not be shipped has lost the
 * result it just spent minutes computing.
 */
export async function post(url, headers, payload, timeoutMs = 10_000) {
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
      // Read the body: an OTLP rejection explains itself there, and without it
      // a 400 is indistinguishable from a 401.
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status}${body ? ` ${body.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    // In a cloud sandbox this is usually the proxy: Node's built-in fetch
    // ignores HTTPS_PROXY, so `403 Host not in allowlist` appears for a host
    // that IS allowlisted. Re-run with NODE_USE_ENV_PROXY=1 (root CLAUDE.md,
    // sandbox baseline point 6).
    return { ok: false, error: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap metrics in the `resourceMetrics` envelope. */
export function metricsEnvelope(serviceName, metrics, extraResource = {}) {
  return {
    resourceMetrics: [{
      resource: { attributes: resourceAttributes(serviceName, extraResource) },
      scopeMetrics: [{
        scope: { name: `lorekit-${serviceName}`, version: '1.0.0' },
        metrics: metrics.filter(Boolean),
      }],
    }],
  };
}

/** Wrap spans in the `resourceSpans` envelope. */
export function spansEnvelope(serviceName, spans, extraResource = {}) {
  return {
    resourceSpans: [{
      resource: { attributes: resourceAttributes(serviceName, extraResource) },
      scopeSpans: [{
        scope: { name: `lorekit-${serviceName}`, version: '1.0.0' },
        spans,
      }],
    }],
  };
}
