import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureFlagOtelHook } from './otel-hook.ts';
import {
  ATTR_FEATURE_FLAG_KEY,
  ATTR_FEATURE_FLAG_PROVIDER_NAME,
  ATTR_FEATURE_FLAG_RESULT_REASON,
  ATTR_FEATURE_FLAG_RESULT_VARIANT,
  EVENT_FEATURE_FLAG_EVALUATION,
} from './otel-attributes.ts';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const contextManager = new AsyncHooksContextManager();

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
  // The default no-op ContextManager never actually tracks "active" context —
  // `context.with()` runs the callback but `trace.getActiveSpan()` inside it
  // would still see nothing without a real one registered.
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(async () => {
  contextManager.disable();
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op test double
const noop = () => {};
const NOOP_LOGGER = { debug: noop, error: noop, info: noop, warn: noop };

function baseHookContext(overrides: Record<string, unknown> = {}) {
  return {
    flagKey: 'new-onboarding-flow',
    defaultValue: false,
    flagValueType: 'boolean',
    context: { targetingKey: 'user-42' },
    clientMetadata: { name: 'test-client' },
    providerMetadata: { name: 'lorekit-flags' },
    logger: NOOP_LOGGER,
    hookData: { get: () => undefined, set: noop, delete: noop },
    ...overrides,
  } as never;
}

describe('featureFlagOtelHook', () => {
  it('stamps feature_flag.* attributes and an evaluation event on the active span', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('evaluate');

    context.with(trace.setSpan(context.active(), span), () => {
      featureFlagOtelHook.after?.(baseHookContext(), {
        flagKey: 'new-onboarding-flow',
        value: true,
        variant: 'treatment',
        reason: 'SPLIT',
        flagMetadata: {},
      });
    });
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes[ATTR_FEATURE_FLAG_KEY]).toBe('new-onboarding-flow');
    expect(exported.attributes[ATTR_FEATURE_FLAG_PROVIDER_NAME]).toBe('lorekit-flags');
    expect(exported.attributes[ATTR_FEATURE_FLAG_RESULT_VARIANT]).toBe('treatment');
    // Lowercased to match the OTel semconv well-known values, even though
    // OpenFeature's own `details.reason` is uppercase ('SPLIT') — see the
    // comment on this transform in otel-hook.ts.
    expect(exported.attributes[ATTR_FEATURE_FLAG_RESULT_REASON]).toBe('split');
    expect(exported.events.some((e) => e.name === EVENT_FEATURE_FLAG_EVALUATION)).toBe(true);
  });

  it('does nothing (no throw) when there is no active span', () => {
    expect(() =>
      featureFlagOtelHook.after?.(baseHookContext(), {
        flagKey: 'new-onboarding-flow',
        value: false,
        variant: 'control',
        reason: 'STATIC',
        flagMetadata: {},
      }),
    ).not.toThrow();
  });

  it('records an exception and the flag key on the error hook', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('evaluate-error');

    context.with(trace.setSpan(context.active(), span), () => {
      featureFlagOtelHook.error?.(baseHookContext(), new Error('provider blew up'));
    });
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes[ATTR_FEATURE_FLAG_KEY]).toBe('new-onboarding-flow');
    expect(exported.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
