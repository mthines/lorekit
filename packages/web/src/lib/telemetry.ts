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
 * Each `logger.*` call writes the record twice, on purpose:
 *   - as an OTLP log record through the global logs API. instrumentation.ts
 *     registers the exporter with @vercel/otel, so the record carries the
 *     spans' resource (service.name=web, service.namespace=lorekit, vcs.*) and
 *     the active span's trace_id / span_id, and reaches Dash0 on /v1/logs.
 *     With no SDK registered (vitest, a local server without an endpoint) the
 *     API is a no-op;
 *   - as single-line JSON on stdout/stderr, for Vercel's runtime log view and
 *     for local development.
 * Do NOT also forward stdout to Dash0 with a Vercel log drain: every record
 * would then arrive twice.
 *
 * PII policy
 * ----------
 * Do NOT attach email addresses, org names, or user-supplied strings to span
 * attributes — those belong to logs at best, and only when operationally
 * necessary. Bounded, safe values (role, org_id, outcome) are fine on spans.
 */

import { trace, context, SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';
import { logs, SeverityNumber, type LogAttributes } from '@opentelemetry/api-logs';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { after } from 'next/server';

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
// OTLP log flush — reaches the SDK provider through the GLOBAL registry.
//
// Next.js compiles instrumentation.ts apart from the route and server-action
// bundles, so a processor exported from a module is not guaranteed to be the
// object @vercel/otel registered. The global logs API is shared across them.
// ---------------------------------------------------------------------------
interface FlushableLoggerProvider {
  forceFlush(): Promise<void>;
}

function isFlushable(provider: object): provider is FlushableLoggerProvider {
  return typeof (provider as Partial<FlushableLoggerProvider>).forceFlush === 'function';
}

/**
 * Export every queued log record now. Resolves at once when no SDK is
 * registered: the API's no-op provider has no `forceFlush`.
 */
export function flushLogs(): Promise<void> {
  const provider = logs.getLoggerProvider();
  return isFlushable(provider) ? provider.forceFlush() : Promise.resolve();
}

/**
 * Flush the log batch once the response has been sent.
 *
 * @vercel/otel flushes spans when a root span ends but flushes the
 * LoggerProvider only on shutdown, and a Vercel function can be frozen between
 * requests with records still queued. `after()` keeps the function alive until
 * the flush settles. It throws outside a request scope (vitest, module init),
 * where the batch processor's own timer still exports.
 */
function scheduleLogFlush(): void {
  try {
    after(flushLogs);
  } catch {
    // Outside a request scope: nothing is about to freeze this process.
  }
}

// ---------------------------------------------------------------------------
// Structured logger — OTLP log record + single-line JSON on stdout/stderr.
// Every record automatically carries trace_id + span_id when called inside a span.
// ---------------------------------------------------------------------------
type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

function emit(level: LogLevel, message: string, attributes: Record<string, unknown> = {}) {
  // Resolved per call rather than once at module load: this module can load
  // before instrumentation.ts registers the provider, and a logger taken from
  // another bundle's copy of the API would never be bound to it.
  logs.getLogger('lorekit.web', '1.0.0').emit({
    severityNumber: SEVERITY_NUMBER[level],
    severityText: level,
    body: message,
    // The SDK stamps trace_id / span_id from the active context itself.
    attributes: attributes as LogAttributes,
  });
  scheduleLogFlush();

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
