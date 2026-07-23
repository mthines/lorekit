/**
 * Shared tracer and meter accessors for @lorekit/core.
 * The OTel SDK is initialised in @lorekit/server — this module only calls the API.
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
