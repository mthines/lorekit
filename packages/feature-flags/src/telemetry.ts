/**
 * Meter accessor for @lorekit/feature-flags.
 *
 * Deliberately self-contained (no dependency on `@lorekit/core`'s
 * `telemetry.ts`, which shares the same shape) — this package evaluates
 * flags on the CLI, the web app, and the edge functions alike, and none of
 * those get to assume the others' OTel SDK setup has already run. The SDK
 * itself is initialised by whichever host process imports this package
 * (`@vercel/otel` in `packages/web`, the lightweight OTLP/JSON client in
 * `packages/cli`, `_shared/telemetry` on the edge) — this module only calls
 * the global `@opentelemetry/api` accessor, so it degrades to the no-op
 * meter/tracer when no SDK is registered instead of throwing.
 */
import { metrics, type Meter } from '@opentelemetry/api';

export const FEATURE_FLAG_METER_NAME = 'lorekit.feature-flags';

export function getFeatureFlagMeter(): Meter {
  return metrics.getMeter(FEATURE_FLAG_METER_NAME, '0.0.1');
}
