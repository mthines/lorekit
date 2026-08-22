/**
 * LoreKit — OTLP metric export for Supabase Edge Functions (Deno)
 *
 * The counterpart to `otel.ts`'s span export, and deliberately thin: it holds
 * the OTLP metric ENVELOPE and nothing else. Resource attributes, endpoint
 * resolution, dataset routing and attribute encoding are all imported from
 * `otel.ts`, so a metric and a span leaving the same isolate describe the same
 * resource — the property that lets Dash0 line them up as one service.
 *
 * Only cumulative monotonic sums are modelled, because that is the only shape
 * the one caller needs. `pg_stat_statements` counters are cumulative since the
 * last reset, so exporting them as cumulative sums lets Dash0 do the
 * differencing (`rate()`) and, crucially, handle a counter RESET correctly on
 * its own: `startTimeUnixNano` carries the stats-reset time, so a reset moves
 * the series start and the backend reads a drop as a new series rather than as
 * negative traffic. Computing deltas ourselves would mean persisting the
 * previous snapshot somewhere and getting reset detection wrong in a new place.
 *
 * Histograms and gauges are absent on purpose. Add one when something needs it,
 * not before.
 *
 * Required secrets (same ones the span exporter uses — nothing new):
 *   OTEL_EXPORTER_OTLP_ENDPOINT
 *   OTEL_EXPORTER_OTLP_HEADERS
 */

import {
  buildResourceAttributes,
  getOtlpConfig,
  resolveServiceName,
  toOtlpValue,
} from './otel.ts';

/** OTLP `AggregationTemporality`. DELTA = 1; we only ever emit CUMULATIVE. */
export const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

/** One cumulative datapoint. */
export interface SumPoint {
  /** Datapoint attributes — the metric's dimensions. Keep these BOUNDED. */
  attributes: Record<string, string | number | boolean>;
  /** The cumulative value as of `timeMs`. */
  value: number;
  /**
   * When this cumulative series started, in ms since the epoch — for a
   * `pg_stat_statements` counter, the last `stats_reset`. A backend needs this
   * to tell "the counter was reset" from "the value went backwards", so it is
   * required rather than optional.
   */
  startTimeMs: number;
  /** When the value was observed, in ms since the epoch. */
  timeMs: number;
}

/** One cumulative monotonic sum metric and its datapoints. */
export interface SumMetric {
  /** Dotted OTel metric name, e.g. `lorekit.db.query.time`. */
  name: string;
  /** UCUM unit, e.g. `s`, `{call}`, `{row}`. */
  unit: string;
  description: string;
  /**
   * Whether the value crosses the wire as an int64 or a double. Counts are
   * `int` (proto3 JSON renders int64 as a STRING — see `renderValue`);
   * durations are `double`.
   */
  valueType: 'int' | 'double';
  points: SumPoint[];
}

/** The outcome of an export attempt. */
export interface MetricExportResult {
  /** True only when the POST returned a 2xx. */
  exported: boolean;
  /** How many datapoints were in the payload. */
  points: number;
  /** HTTP status, when a response was received. */
  status?: number;
  /** Why the export did not happen or did not succeed. */
  error?: string;
}

function toUnixNano(ms: number): string {
  // Integer arithmetic on a ms epoch — `ms * 1e6` in floating point loses
  // precision at nanosecond scale, and OTLP wants an integer string anyway.
  return `${Math.round(ms)}000000`;
}

/**
 * Render a datapoint value in the field its type demands.
 *
 * proto3 JSON maps int64 to a STRING, so `asInt` must be quoted; `asDouble` is
 * a plain JSON number. Sending an int64 as a bare number is the classic OTLP
 * JSON rejection, and a rejected payload is a silent 400 nobody looks at.
 */
function renderValue(value: number, valueType: 'int' | 'double') {
  return valueType === 'int'
    ? { asInt: String(Math.round(value)) }
    : { asDouble: value };
}

/**
 * Build the OTLP/JSON `resourceMetrics` envelope for a set of sums.
 *
 * `environmentOverride` mirrors the span path's per-batch override so a smoke
 * run can tag its metrics `deployment.environment.name=test` and keep synthetic
 * numbers out of a production view.
 */
export function buildOtlpMetricsPayload(
  metrics: readonly SumMetric[],
  opts: { environmentOverride?: string } = {},
): unknown {
  return {
    resourceMetrics: [{
      resource: { attributes: buildResourceAttributes(opts) },
      scopeMetrics: [{
        scope: { name: `lorekit-${resolveServiceName()}`, version: '1.0.0' },
        metrics: metrics.map((m) => ({
          name: m.name,
          unit: m.unit,
          description: m.description,
          sum: {
            aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
            // These only ever go up (within a series — a reset starts a new
            // one, which is what startTimeUnixNano communicates).
            isMonotonic: true,
            dataPoints: m.points.map((p) => ({
              startTimeUnixNano: toUnixNano(p.startTimeMs),
              timeUnixNano: toUnixNano(p.timeMs),
              ...renderValue(p.value, m.valueType),
              attributes: Object.entries(p.attributes).map(([key, value]) => ({
                key,
                value: toOtlpValue(value),
              })),
            })),
          },
        })),
      }],
    }],
  };
}

/**
 * POST the metrics to Dash0 and RESOLVE with the outcome.
 *
 * Unlike `ExportBatch.flush()`, this is awaited and its result is reported.
 * A span export is a side effect of serving a request, so swallowing its
 * failure is right — the request still succeeded. Here the export IS the
 * request: a caller that swallowed the failure would answer `200 OK` to a cron
 * job while sending nothing, and the only symptom would be a dashboard that
 * quietly stopped updating. So every failure path returns a reason instead of
 * throwing, and the caller decides the status code.
 */
export async function exportMetrics(
  metrics: readonly SumMetric[],
  opts: { environmentOverride?: string } = {},
): Promise<MetricExportResult> {
  const points = metrics.reduce((n, m) => n + m.points.length, 0);
  if (points === 0) return { exported: false, points: 0, error: 'no datapoints to export' };

  const cfg = getOtlpConfig();
  // Local development and any deployment without the Dash0 secrets. Not an
  // error — there is simply nowhere to send. Reported so the caller can say so
  // rather than implying a successful export.
  if (!cfg) return { exported: false, points, error: 'OTEL_EXPORTER_OTLP_ENDPOINT is not set' };

  try {
    const res = await fetch(`${cfg.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.headers },
      body: JSON.stringify(buildOtlpMetricsPayload(metrics, opts)),
    });
    if (!res.ok) {
      // Read the body: an OTLP rejection explains itself there, and without it
      // a 400 is indistinguishable from a 401.
      const body = await res.text().catch(() => '');
      return {
        exported: false,
        points,
        status: res.status,
        error: `OTLP metrics export failed: ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
      };
    }
    return { exported: true, points, status: res.status };
  } catch (err) {
    return { exported: false, points, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}
