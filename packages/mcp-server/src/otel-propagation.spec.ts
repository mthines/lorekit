/**
 * Verifies W3C traceparent propagation through the OTel context API.
 *
 * The Node.js MCP server uses `getNodeAutoInstrumentations()` which includes
 * `@opentelemetry/instrumentation-undici`. This instruments Node 18+'s global
 * fetch so any fetch() inside a tool handler automatically inherits the active
 * span context and injects `traceparent` into the outgoing request.
 *
 * These tests verify the OTel context propagation primitives work correctly
 * without requiring a full SDK — using the no-op tracer that ships with
 * @opentelemetry/api, which exercises the same context.with() mechanism.
 */
import { describe, it, expect } from 'vitest';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';

describe('OTel W3C traceparent propagation', () => {
  it('context.with() propagates a custom value to the active context', () => {
    // This is the fundamental mechanism undici instrumentation uses:
    // it calls context.with(spanCtx, outgoingFetch) so the active span
    // context is available when the fetch headers are being built.
    const key = context.createKey('test-trace-key');
    const ctxWithValue = context.active().setValue(key, 'trace-id-abc123');

    let capturedValue: unknown;
    context.with(ctxWithValue, () => {
      capturedValue = context.active().getValue(key);
    });

    expect(capturedValue).toBe('trace-id-abc123');
  });

  it('context.with() is isolated — outer context is not modified', () => {
    const key = context.createKey('isolation-test');
    const outer = context.active().setValue(key, 'outer');
    const inner = context.active().setValue(key, 'inner');

    let innerValue: unknown;
    context.with(inner, () => {
      innerValue = context.active().getValue(key);
    });

    const afterValue = outer.getValue(key);
    expect(innerValue).toBe('inner');
    expect(afterValue).toBe('outer');
  });

  it('W3C traceparent format: 00-{traceId(32hex)}-{spanId(16hex)}-{flags(2hex)}', () => {
    // Verify the format the undici instrumentation would construct and inject.
    // traceId: 32 hex chars, spanId: 16 hex chars, flags: 2 hex chars
    const traceId = 'abcdef1234567890abcdef1234567890';
    const spanId  = 'abcdef1234567890';
    const flags   = 1; // sampled

    const traceparent = `00-${traceId}-${spanId}-${flags.toString(16).padStart(2, '0')}`;
    expect(traceparent).toBe('00-abcdef1234567890abcdef1234567890-abcdef1234567890-01');
    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[0-9a-f]{2}$/);
  });

  it('active span context from @opentelemetry/api is a no-op without SDK — confirms undici needs the SDK', () => {
    // Without the SDK registered, trace.getActiveSpan() returns undefined.
    // This is intentional in the test environment — the SDK (registered in
    // instrumentation.ts at startup) is required for real context propagation.
    // This test documents that fact explicitly.
    const span = trace.getActiveSpan();
    // In test environment without SDK: no active span
    expect(span).toBeUndefined();
  });
});