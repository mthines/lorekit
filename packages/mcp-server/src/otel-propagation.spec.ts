/**
 * Verifies W3C traceparent propagation through the OTel context API.
 *
 * The Node.js MCP server uses `getNodeAutoInstrumentations()` which includes
 * `@opentelemetry/instrumentation-undici`. This instruments Node 18+'s global
 * `fetch` so any fetch() inside a tool handler automatically inherits the active
 * span context and injects `traceparent` into the outgoing request.
 *
 * This test uses an in-memory tracer (from @opentelemetry/sdk-trace-base) to
 * verify that the OTel context API propagates a span through `context.with()`,
 * which is the exact mechanism the SDK uses when running handlers inside spans.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// ── In-memory tracer setup ─────────────────────────────────────────────────
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
const tracer = provider.getTracer('test');

describe('OTel W3C traceparent propagation', () => {
  afterEach(() => exporter.reset());

  it('active span context is accessible inside context.with()', () => {
    // This mirrors what the http instrumentation does when it extracts an
    // incoming traceparent and sets up the active context for a request.
    const span = tracer.startSpan('test-span');
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    let capturedTraceId: string | undefined;
    context.with(ctx, () => {
      const activeSpan = trace.getActiveSpan();
      capturedTraceId = activeSpan?.spanContext().traceId;
    });

    expect(capturedTraceId).toBe(span.spanContext().traceId);
    expect(capturedTraceId).toMatch(/^[a-f0-9]{32}$/);
    span.end();
  });

  it('child spans share the parent traceId (traceparent propagation contract)', () => {
    const parent = tracer.startSpan('parent');
    const ctx = trace.setSpan(ROOT_CONTEXT, parent);

    let childTraceId: string | undefined;
    let childParentSpanId: string | undefined;
    context.with(ctx, () => {
      const child = tracer.startSpan('child');
      childTraceId = child.spanContext().traceId;
      // Access parent span context from the active context
      childParentSpanId = trace.getActiveSpan()?.spanContext().spanId;
      child.end();
    });

    // Child shares the same traceId as the parent — this is the W3C trace contract.
    expect(childTraceId).toBe(parent.spanContext().traceId);
    // The parent span is the active span inside context.with()
    expect(childParentSpanId).toBe(parent.spanContext().spanId);
    parent.end();
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