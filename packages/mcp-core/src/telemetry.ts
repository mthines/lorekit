/**
 * Shared tracer and meter accessors for @lorekit/core.
 *
 * API-ONLY. This module never initialises an SDK — it calls `@opentelemetry/api`,
 * which is a no-op unless some host has registered a provider. No host currently
 * does: the only callers are `limits.ts` and `tools/*`, and their last runtime
 * consumer was the undeployed Node MCP server, deleted along with the
 * `@lorekit/server` package this docblock used to point at (see
 * docs/decisions.md -> "No Node MCP server, no Fly.io"). The production MCP
 * server is the Deno Edge Function, which has its own SDK setup in
 * `supabase/functions/_shared/otel.ts` and does not import this module.
 *
 * So the spans and metrics below are recorded against a no-op provider today.
 * That is intentional and harmless — the accessors stay so a future host (the
 * BYOD/library path) can register a provider and light them up without touching
 * every call site — but do not read a `getTracer()` call here as evidence that
 * anything is being exported.
 */
import { trace, metrics, type Tracer, type Meter, type Histogram } from '@opentelemetry/api';

export const TRACER_NAME = 'lorekit';
export const METER_NAME = 'lorekit';

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, '0.0.1');
}

export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME, '0.0.1');
}

let _toolDurationHistogram: Histogram | undefined;

/**
 * lorekit.tool.duration — histogram of MCP tool call durations.
 * Attributes: lorekit.tool.name, lorekit.scope.type
 */
export function getToolDurationHistogram(): Histogram {
  if (!_toolDurationHistogram) {
    _toolDurationHistogram = getMeter().createHistogram('lorekit.tool.duration', {
      description: 'Duration of LoreKit MCP tool calls',
      unit: 's',
    });
  }
  return _toolDurationHistogram;
}
