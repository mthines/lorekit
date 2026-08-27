import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateFlag, resetFeatureFlagClientForTests } from './client.ts';

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
});
