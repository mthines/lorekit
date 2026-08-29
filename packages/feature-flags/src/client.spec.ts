/**
 * `client.ts` is the one module that binds to the LIVE registry — `evaluateFlag`
 * resolves its fallback and its value type from `getFlagDefinition(key)`, and
 * `FlagKey` is the generated union — so these tests are necessarily written
 * against real, shipped flags.
 *
 * That makes them the wrong place to prove value-type coverage. They used to
 * assert the string and object paths through `plan-badge-copy` /
 * `usage-empty-state-copy`, two registry entries that existed ONLY to be
 * asserted here; deleting the demo flags took the assertions with them, and
 * nothing was lost — `provider.spec.ts` covers all four value types, the
 * weighted experiment split and the override path against `FlagDefinition`
 * fixtures it declares itself, which is where a test of the mechanism belongs.
 *
 * What is left here is what only this layer can check: that `evaluateFlag`
 * threads a real registry entry's default through the OpenFeature client, that
 * `evaluateFlagDetails` surfaces `variant`/`reason`, that an override wins, and
 * that a key the generated union does not contain fails loudly instead of
 * resolving to `undefined`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateFlag, evaluateFlagDetails, resetFeatureFlagClientForTests } from './client.ts';

describe('evaluateFlag', () => {
  beforeEach(() => {
    resetFeatureFlagClientForTests();
  });

  it('resolves a static boolean flag to its default variant value', async () => {
    expect(await evaluateFlag('insights-page')).toBe(false);
  });

  it('resolves the same flag identically across calls (no per-call state)', async () => {
    const a = await evaluateFlag('retention-policies', { targetingKey: 'user-1' });
    const b = await evaluateFlag('retention-policies', { targetingKey: 'user-1' });
    expect(a).toBe(b);
    expect(typeof a).toBe('boolean');
  });

  it('rejects an unknown flag key at compile time (type-level) — runtime guard for drift', async () => {
    // @ts-expect-error — 'not-a-real-flag' is not a member of the generated FlagKey union.
    await expect(evaluateFlag('not-a-real-flag')).rejects.toThrow(/unknown flag/);
  });
});

describe('evaluateFlagDetails', () => {
  beforeEach(() => {
    resetFeatureFlagClientForTests();
  });

  it('returns variant and reason alongside the value', async () => {
    const details = await evaluateFlagDetails('insights-page');
    expect(details).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });

  it('reports OVERRIDE when a session override is present', async () => {
    const details = await evaluateFlagDetails('insights-page', {
      flagOverrides: { 'insights-page': 'on' },
    });
    expect(details).toMatchObject({ value: true, variant: 'on', reason: 'OVERRIDE' });
  });
});
