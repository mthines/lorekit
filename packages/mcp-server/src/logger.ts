/**
 * Structured pino logger with automatic trace/span correlation.
 * Every log record includes trace_id and span_id from the active OTel span context.
 * Per otel-instrumentation/rules/sdks/nodejs.md — structured logging + trace correlation.
 */
import pino from 'pino';
import { trace, context } from '@opentelemetry/api';

function getTraceContext(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (!spanContext) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
  };
}

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  formatters: {
    log(obj) {
      return { ...getTraceContext(), ...obj };
    },
  },
});
