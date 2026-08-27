import { ErrorCode, StandardResolutionReasons } from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';
import { LoreKitFlagProvider } from './provider.ts';
import type { FlagDefinition } from './schema.ts';

// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op test double
const noop = () => {};
const NOOP_LOGGER = { debug: noop, error: noop, info: noop, warn: noop };

const staticFlag: FlagDefinition = {
  key: 'static-flag',
  description: 'A static, non-experiment flag.',
  type: 'boolean',
  variants: { off: false, on: true },
  defaultVariant: 'off',
  owner: '@lorekit/web',
  tags: [],
};

const experimentFlag: FlagDefinition = {
  key: 'experiment-flag',
  description: 'An A/B experiment flag.',
  type: 'boolean',
  variants: { control: false, treatment: true },
  defaultVariant: 'control',
  experiment: {
    enabled: true,
    variants: [
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },
    ],
  },
  owner: '@lorekit/web',
  tags: [],
};

const numberFlag: FlagDefinition = {
  key: 'number-flag',
  description: 'A numeric flag.',
  type: 'number',
  variants: { low: 1, high: 10 },
  defaultVariant: 'low',
  owner: '@lorekit/web',
  tags: [],
};

describe('LoreKitFlagProvider', () => {
  it('resolves a static boolean flag with reason STATIC', async () => {
    const provider = new LoreKitFlagProvider([staticFlag]);
    const result = await provider.resolveBooleanEvaluation('static-flag', false, {}, NOOP_LOGGER);
    expect(result).toMatchObject({
      value: false,
      variant: 'off',
      reason: StandardResolutionReasons.STATIC,
    });
  });

  it('returns FLAG_NOT_FOUND for an unknown key', async () => {
    const provider = new LoreKitFlagProvider([staticFlag]);
    const result = await provider.resolveBooleanEvaluation('does-not-exist', true, {}, NOOP_LOGGER);
    expect(result.value).toBe(true);
    expect(result.errorCode).toBe(ErrorCode.FLAG_NOT_FOUND);
  });

  it('returns TYPE_MISMATCH when the requested method does not match the flag type', async () => {
    const provider = new LoreKitFlagProvider([staticFlag]);
    const result = await provider.resolveStringEvaluation(
      'static-flag',
      'fallback',
      {},
      NOOP_LOGGER,
    );
    expect(result.errorCode).toBe(ErrorCode.TYPE_MISMATCH);
    expect(result.value).toBe('fallback');
  });

  it('resolves a number flag correctly', async () => {
    const provider = new LoreKitFlagProvider([numberFlag]);
    const result = await provider.resolveNumberEvaluation('number-flag', 0, {}, NOOP_LOGGER);
    expect(result).toMatchObject({
      value: 1,
      variant: 'low',
      reason: StandardResolutionReasons.STATIC,
    });
  });

  it('resolves an experiment flag with reason SPLIT and a deterministic variant', async () => {
    const provider = new LoreKitFlagProvider([experimentFlag]);
    const context = { targetingKey: 'user-123' };
    const first = await provider.resolveBooleanEvaluation(
      'experiment-flag',
      false,
      context,
      NOOP_LOGGER,
    );
    const second = await provider.resolveBooleanEvaluation(
      'experiment-flag',
      false,
      context,
      NOOP_LOGGER,
    );
    expect(first.reason).toBe(StandardResolutionReasons.SPLIT);
    expect(first).toEqual(second);
    expect(['control', 'treatment']).toContain(first.variant);
  });

  it('falls back to an anonymous targeting key when the context carries none', async () => {
    const provider = new LoreKitFlagProvider([experimentFlag]);
    const result = await provider.resolveBooleanEvaluation(
      'experiment-flag',
      false,
      {},
      NOOP_LOGGER,
    );
    expect(result.reason).toBe(StandardResolutionReasons.SPLIT);
    expect(['control', 'treatment']).toContain(result.variant);
  });

  it('refuses object evaluation — no object-typed flags are supported yet', async () => {
    const provider = new LoreKitFlagProvider([staticFlag]);
    const result = await provider.resolveObjectEvaluation('static-flag', { a: 1 }, {}, NOOP_LOGGER);
    expect(result.errorCode).toBe(ErrorCode.TYPE_MISMATCH);
    expect(result.value).toEqual({ a: 1 });
  });
});
