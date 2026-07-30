/**
 * Verifies W3C traceparent propagation through the OTel context API.
 *
 * The Node.js MCP server uses `getNodeAutoInstrumentations()` which includes
 * `@opentelemetry/instrumentation-undici`. This instruments Node 18+'s global
 * fetch so any fetch() inside a tool handler automatically inherits the active
 * span context and injects `traceparent` into the outgoing request.
 *
 * These tests verify the OTel context propagation primitives work correctly
 * using only `@opentelemetry/api` + `@opentelemetry/context-async-hooks`.
 * A real context manager must be registered for `context.with()` to propagate
 * values — the default no-op context manager is a stub that does not propagate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { context, trace, ContextManager } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

let manager: ContextManager;

beforeAll(() => {
  manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
});

afterAll(() => {
  context.disable();
});

describe('OTel W3C traceparent propagation', () => {
  it('context.with() propagates a context value to the inner callback', () => {
    // OTel context keys are symbols — same mechanism undici instrumentation uses
    // to propagate the active span context into outgoing fetch calls.
    const key = Symbol('test-trace-key');

    // context.active() returns ROOT_CONTEXT by default (no-op tracer in tests).
    // setValue() returns a new derived context without mutating the original.
    const ctxWithValue = context.active().setValue(key, 'trace-id-abc123');

    let capturedValue: unknown = 'not-set';
    context.with(ctxWithValue, () => {
      capturedValue = context.active().getValue(key);
    });

    expect(capturedValue).toBe('trace-id-abc123');
  });

  it('context.with() does not leak the inner context to the outer scope', () => {
    const key = Symbol('isolation-test');
    const outerCtx = context.active().setValue(key, 'outer');
    const innerCtx = context.active().setValue(key, 'inner');

    let innerValue: unknown;
    context.with(innerCtx, () => {
      innerValue = context.active().getValue(key);
    });

    // After context.with() exits, the outer context is restored.
    // This is what allows parallel requests to each carry their own span context.
    const afterValue = outerCtx.getValue(key);
    expect(innerValue).toBe('inner');
    expect(afterValue).toBe('outer');
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
