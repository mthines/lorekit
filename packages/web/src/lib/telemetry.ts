/**
 * Shared OpenTelemetry helpers for the web package.
 *
 * The SDK is initialised by @vercel/otel in instrumentation.ts. These helpers
 * call the stable `@opentelemetry/api` surface — a no-op tracer / logger is
 * returned automatically when no SDK is registered (e.g. under vitest).
 *
 * Usage
 * -----
 *   import { withSpan, logger } from '@/lib/telemetry';
 *
 *   await withSpan('lorekit.org.create', { 'lorekit.org.role': 'owner' }, async (span) => {
 *     span.setAttribute('lorekit.org.id', orgId);
 *     ...
 *   });
 *
 * Logging
 * -------
 * Logs are written to stdout as structured JSON (Next.js / Vercel captures
 * stdout). They intentionally do NOT use the OTel Logs SDK exporter to avoid
 * duplicate delivery — the Vercel log drain already forwards stdout to Dash0.
 * See: agent-skills/skills/otel-instrumentation/rules/logs.md § "Stdout vs OTLP"
 *
 * PII policy
 * ----------
 * Do NOT attach email addresses, org names, or user-supplied strings to span
 * attributes — those belong to logs at best, and only when operationally
 * necessary. Bounded, safe values (role, org_id, outcome) are fine on spans.
 */

import { trace, context, SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

export { SpanStatusCode, SpanKind };

// ---------------------------------------------------------------------------
// Tracer — one per service component, consistent with mcp-core/src/telemetry.ts
// ---------------------------------------------------------------------------
export const tracer = trace.getTracer('lorekit.web', '1.0.0');

// ---------------------------------------------------------------------------
// Trace correlation — extract trace_id / span_id from the active span so
// structured log records can be correlated with the span that produced them.
// ---------------------------------------------------------------------------
export function getTraceContext(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

// ---------------------------------------------------------------------------
// Structured logger — writes single-line JSON to stdout.
// Every record automatically carries trace_id + span_id when called inside a span.
// ---------------------------------------------------------------------------
type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function emit(level: LogLevel, message: string, attributes: Record<string, unknown> = {}) {
  // Single-line JSON — no pretty-printing; stack traces arrive pre-serialised
  // as a string value in exception.stacktrace so the one-record-per-line
  // contract is never broken. The filelog receiver / Vercel log drain parses
  // each line as a separate record.
  const record = {
    level,
    msg: message,
    ...getTraceContext(),
    ...attributes,
  };
  const line = JSON.stringify(record);
  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(line + '\n');
    return;
  }
  process.stdout.write(line + '\n');
}

export const logger = {
  info(message: string, attributes: Record<string, unknown> = {}) {
    emit('INFO', message, attributes);
  },
  warn(message: string, attributes: Record<string, unknown> = {}) {
    emit('WARN', message, attributes);
  },
  error(message: string, attributes: Record<string, unknown> = {}) {
    emit('ERROR', message, attributes);
  },
};

// ---------------------------------------------------------------------------
// withSpan — wraps an async function in an INTERNAL span.
//
// Use SpanKind.SERVER for the outermost server-action boundary when you want
// to model the action as an inbound call. INTERNAL is the default for nested
// spans.
//
// On success the span status is left UNSET (correct unless the caller
// explicitly confirms success via span.setStatus({ code: SpanStatusCode.OK })).
// On error the span status is set to ERROR with a message, and a structured
// error log record is emitted with exception details and trace correlation so
// it can be found from the span.
// ---------------------------------------------------------------------------
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind }, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      return await fn(span);
    } catch (err) {
      const error = err as Error;
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${error.name}: ${error.message}`,
      });
      span.setAttribute(ATTR_ERROR_TYPE, error.name);
      // Record the exception as a structured log record — not span.recordException()
      // which uses the deprecated Span Event API.
      logger.error(`${name}.failed`, {
        'exception.type': error.name,
        'exception.message': error.message,
        'exception.stacktrace': error.stack ?? '',
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
