/**
 * Verifies W3C traceparent propagation through the OTel context API.
 *
 * The Node.js MCP server uses `getNodeAutoInstrumentations()` which includes
 * `@opentelemetry/instrumentation-undici`. This instruments Node 18+'s global
 * `fetch` so any fetch() inside a tool handler automatically inherits the active
 * span context and injects `traceparent` into the outgoing request.
 *
 * These tests verify that the OTel context propagation primitives work correctly
 * using a globally-registered in-memory tracer — the same mechanism the SDK
 * uses when running inside a real request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  // Must register globally so trace.getActiveSpan() works
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

describe('OTel W3C traceparent propagation', () => {
  it('active span is accessible via trace.getActiveSpan() inside context.with()', () => {
    const tracer = trace.getTracer('test');
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

  it('child span inherits the parent traceId — W3C trace context contract', () => {
    const tracer = trace.getTracer('test');
    const parent = tracer.startSpan('parent-span');
    const parentCtx = trace.setSpan(ROOT_CONTEXT, parent);

    let childTraceId: string | undefined;
    let childSpanId: string | undefined;
    context.with(parentCtx, () => {
      // startSpan inside context.with uses the active span as parent
      const child = tracer.startSpan('child-span');
      childTraceId = child.spanContext().traceId;
      childSpanId = child.spanContext().spanId;
      child.end();
    });

    parent.end();

    // The child must share the same traceId as its parent — W3C trace contract
    expect(childTraceId).toBe(parent.spanContext().traceId);
    // The child span has its own unique spanId
    expect(childSpanId).not.toBe(parent.spanContext().spanId);
  });

  it('W3C traceparent format: 00-{traceId(32hex)}-{spanId(16hex)}-{flags(2hex)}', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('format-test');
    const { traceId, spanId, traceFlags } = span.spanContext();

    const traceparent = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;

    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[0-9a-f]{2}$/);
    span.end();
  });
});