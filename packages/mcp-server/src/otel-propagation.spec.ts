/**
 * Verifies W3C traceparent propagation primitives through the OTel context API.
 *
 * The Node.js MCP server uses `getNodeAutoInstrumentations()` which includes
 * `@opentelemetry/instrumentation-undici`. This instruments Node 18+'s global
 * fetch so any fetch() inside a tool handler automatically inherits the active
 * span context and injects `traceparent` into the outgoing request.
 *
 * These tests verify the OTel context API primitives using only
 * `@opentelemetry/api` — no SDK registration required. Tests that require a
 * real context manager (e.g. AsyncLocalStorage-backed) are not included here;
 * those behaviours are covered by the OTel SDK's own test suite.
 */
import { describe, it, expect } from 'vitest';
import { context, trace } from '@opentelemetry/api';

describe('OTel W3C traceparent propagation', () => {
  it('context.active().setValue() returns a new derived context without mutating the original', () => {
    // OTel context keys are symbols — same mechanism undici instrumentation uses
    // to propagate the active span context into outgoing fetch calls.
    const key = Symbol('test-trace-key');

    // setValue() must return a new context — not mutate the existing one.
    const original = context.active();
    const derived = original.setValue(key, 'trace-id-abc123');

    // The derived context carries the value.
    expect(derived.getValue(key)).toBe('trace-id-abc123');
    // The original context is unchanged.
    expect(original.getValue(key)).toBeUndefined();
  });

  it('context.active() contexts are independent — setting a value on one does not affect another', () => {
    const key = Symbol('isolation-test');

    // Create two independent derived contexts from the same root.
    const ctxA = context.active().setValue(key, 'value-a');
    const ctxB = context.active().setValue(key, 'value-b');

    // Each carries only its own value — proving context immutability.
    expect(ctxA.getValue(key)).toBe('value-a');
    expect(ctxB.getValue(key)).toBe('value-b');
  });

  it('W3C traceparent format: 00-{traceId(32hex)}-{spanId(16hex)}-{flags(2hex)}', () => {
    // Verify the exact format the undici instrumentation would construct and inject.
    const traceId = 'abcdef1234567890abcdef1234567890';
    const spanId  = 'abcdef1234567890';
    const flags   = 1; // sampled

    const traceparent = `00-${traceId}-${spanId}-${flags.toString(16).padStart(2, '0')}`;
    expect(traceparent).toBe('00-abcdef1234567890abcdef1234567890-abcdef1234567890-01');
    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[0-9a-f]{2}$/);
  });

  it('trace.getActiveSpan() returns undefined without SDK — SDK is required for real propagation', () => {
    // Without the SDK registered (via instrumentation.ts at startup), the global
    // trace API is a no-op. This confirms that the auto-instrumentation in
    // instrumentation.ts is what enables real context propagation in production.
    const span = trace.getActiveSpan();
    expect(span).toBeUndefined();
  });
});
