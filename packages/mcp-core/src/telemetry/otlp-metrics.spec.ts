import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * EXECUTING cover for the edge OTLP metrics envelope
 * (`supabase/functions/_shared/telemetry/otlp-metrics.ts`): a cumulative sum
 * goes out under `sum` with temporality CUMULATIVE and `isMonotonic`, a gauge
 * under `gauge` with neither — the shape `lorekit.db.table.live_tup` /
 * `dead_tup` (00125) depend on. A gauge sent as a monotonic sum would be
 * differenced by the backend into nonsense whenever autovacuum lowered it.
 *
 * Loaded by a DYNAMIC import over a computed path, as `otel-detached-child.spec.ts`
 * does and for the same reason: `supabase/` is another NX project, so a static
 * relative specifier is a module-boundary error.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildOtlpMetricsPayload } = (await import(
  pathToFileURL(path.join(repoRoot, 'supabase', 'functions', '_shared', 'telemetry', 'otlp-metrics.ts')).href
)) as {
  buildOtlpMetricsPayload: (metrics: readonly unknown[], opts?: { environmentOverride?: string }) => unknown;
};

let hadDeno: boolean;

beforeEach(() => {
  hadDeno = 'Deno' in globalThis;
  (globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined } };
});

afterEach(() => {
  if (!hadDeno) delete (globalThis as Record<string, unknown>).Deno;
});

const point = { attributes: { 'db.table': 'memories' }, value: 7, startTimeMs: 1000, timeMs: 2000 };

function metricsOf(payload: unknown): Array<Record<string, unknown>> {
  const p = payload as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<Record<string, unknown>> }> }> };
  return p.resourceMetrics[0].scopeMetrics[0].metrics;
}

describe('buildOtlpMetricsPayload', () => {
  it('renders a metric without a kind as a cumulative monotonic sum (unchanged default)', () => {
    const [m] = metricsOf(buildOtlpMetricsPayload([
      { name: 'lorekit.db.query.calls', unit: '{call}', description: 'd', valueType: 'int', points: [point] },
    ]));
    expect(m.gauge).toBeUndefined();
    expect(m.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
    expect((m.sum as { dataPoints: unknown[] }).dataPoints[0]).toMatchObject({
      asInt: '7',
      startTimeUnixNano: '1000000000',
      timeUnixNano: '2000000000',
      attributes: [{ key: 'db.table', value: { stringValue: 'memories' } }],
    });
  });

  it('renders kind "gauge" under gauge, with no temporality or monotonic flag', () => {
    const [sum, gauge] = metricsOf(buildOtlpMetricsPayload([
      { name: 'lorekit.db.table.tup_upd', unit: '{row}', description: 'd', valueType: 'int', kind: 'sum', points: [point] },
      { name: 'lorekit.db.table.dead_tup', unit: '{row}', description: 'd', valueType: 'int', kind: 'gauge', points: [point] },
    ]));
    expect(sum.sum).toBeDefined();
    expect(gauge.sum).toBeUndefined();
    expect(gauge).toMatchObject({ name: 'lorekit.db.table.dead_tup', unit: '{row}' });
    expect(gauge.gauge).toEqual({
      dataPoints: [{
        startTimeUnixNano: '1000000000',
        timeUnixNano: '2000000000',
        asInt: '7',
        attributes: [{ key: 'db.table', value: { stringValue: 'memories' } }],
      }],
    });
  });
});
