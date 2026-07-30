/**
 * Verifies W3C traceparent propagation through the OTel context API.
 *
 * The Node.js MCP server uses `getNodeAutoInstrumentations()` which includes
 * `@opentelemetry/instrumentation-undici`. This instruments Node 18+'s global
 * `fetch` so any fetch() inside a tool handler automatically inherits the active
 * span context and injects `traceparent` into the outgoing request.
 *
 * This test uses an in-memory tracer (from @opentelemetry/sdk-trace-base) to
 * verify that the OTel context API correctly encodes a span into a context value
 * and that the tracer propagates that context to child spans — the same mechanism
 * the SDK uses when running handlers inside spans.
 *
 * Note: tests use the explicit-context form of the OTel API (trace.setSpan /
 * trace.getSpan / tracer.startSpan with a ctx arg) rather than the global
 * context manager (context.with + trace.getActiveSpan). The global context
 * manager requires AsyncLocalStorageContextManager to be installed, which is
 * done by NodeSDK.start() at server boot — not in unit tests. The explicit-
 * context form tests the same propagation contract without global state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { trace, ROOT_CONTEXT } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// ── In-memory tracer setup ─────────────────────────────────────────────────
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();
const tracer = provider.getTracer('test');

describe('OTel W3C traceparent propagation', () => {
  afterEach(() => exporter.reset());

  it('active span context is accessible via trace.getSpan(ctx)', () => {
    // This mirrors what the http instrumentation does when it extracts an
    // incoming traceparent and sets up the active context for a request.
    // trace.setSpan encodes the span into a context value; trace.getSpan
    // retrieves it — the same encoding context.with() uses internally.
    const span = tracer.startSpan('test-span');
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    const retrievedSpan = trace.getSpan(ctx);
    const capturedTraceId = retrievedSpan?.spanContext().traceId;

    expect(capturedTraceId).toBe(span.spanContext().traceId);
    expect(capturedTraceId).toMatch(/^[a-f0-9]{32}$/);
    span.end();
  });

  it('child spans share the parent traceId (traceparent propagation contract)', () => {
    const parent = tracer.startSpan('parent');
    const ctx = trace.setSpan(ROOT_CONTEXT, parent);

    // Pass ctx explicitly — the same mechanism context.with() uses to propagate
    // the active span context into child span creation.
    const child = tracer.startSpan('child', {}, ctx);
    const childTraceId = child.spanContext().traceId;
    child.end();
    parent.end();

    // Inspect the recorded spans to verify parent linkage.
    const spans = exporter.getFinishedSpans();
    const childSpan = spans.find(s => s.name === 'child');

    // Child shares the same traceId as the parent — this is the W3C trace contract.
    expect(childTraceId).toBe(parent.spanContext().traceId);
    // The parent's spanId is the child's parentSpanId (from the exporter's ReadableSpan).
    expect(childSpan?.parentSpanId).toBe(parent.spanContext().spanId);
  });

  it('W3C traceparent format: 00-{traceId}-{spanId}-{flags}', () => {
    const span = tracer.startSpan('format-test');
    const { traceId, spanId, traceFlags } = span.spanContext();

    // Build the W3C traceparent header that undici instrumentation would inject
    const traceparent = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;

    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[0-9a-f]{2}$/);
    span.end();
  });
});
