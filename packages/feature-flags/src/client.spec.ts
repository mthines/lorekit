import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateFlag, evaluateFlagDetails, resetFeatureFlagClientForTests } from './client.ts';

describe('evaluateFlag', () => {
  beforeEach(() => {
    resetFeatureFlagClientForTests();
  });

  it('resolves a static boolean flag to its default variant value', async () => {
    expect(await evaluateFlag('usage-charts-v2')).toBe(false);
  });

  it('resolves an experiment flag deterministically for the same targeting key', async () => {
    const a = await evaluateFlag('new-onboarding-flow', {
      targetingKey: 'user-1',
    });
    const b = await evaluateFlag('new-onboarding-flow', {
      targetingKey: 'user-1',
    });
    expect(a).toBe(b);
    expect(typeof a).toBe('boolean');
  });

  it('rejects an unknown flag key at compile time (type-level) — runtime guard for drift', async () => {
    // @ts-expect-error — 'not-a-real-flag' is not a member of the generated FlagKey union.
    await expect(evaluateFlag('not-a-real-flag')).rejects.toThrow(/unknown flag/);
  });

  it('resolves a string-typed flag to a string', async () => {
    const value = await evaluateFlag('plan-badge-copy');
    expect(value).toBe('Beta');
  });

  it('resolves an object-typed flag to its whole nested value', async () => {
    const value = await evaluateFlag('usage-empty-state-copy');
    expect(value).toEqual({
      title: 'No usage yet',
      ctaLabel: 'Learn more',
      ctaHref: '/docs/limits',
    });
  });
});

describe('evaluateFlagDetails', () => {
  beforeEach(() => {
    resetFeatureFlagClientForTests();
  });

  it('returns variant and reason alongside the value', async () => {
    const details = await evaluateFlagDetails('usage-charts-v2');
    expect(details).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });

  it('reports OVERRIDE when a session override is present', async () => {
    const details = await evaluateFlagDetails('usage-charts-v2', {
      flagOverrides: { 'usage-charts-v2': 'on' },
    });
    expect(details).toMatchObject({ value: true, variant: 'on', reason: 'OVERRIDE' });
  });
});
