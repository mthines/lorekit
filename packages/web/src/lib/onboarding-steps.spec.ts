/**
 * Pins the render-path binding the first-sign-in fix depends on: the `/lore`
 * onboarding render mints through `mintToken(..., 'onboarding')`, never the
 * `'use server'` `generateToken` action whose success path calls
 * `revalidatePath` (which Next 15 forbids during render). Pointing the render
 * back at `generateToken` — the original bug — fails this spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';

// The node-env vitest transform compiles JSX to `React.createElement`, so the
// module under test needs React in scope at call time.
vi.stubGlobal('React', React);

vi.mock('server-only', () => ({}));

const listTokens = vi.fn();
const generateToken = vi.fn();
vi.mock('@/lib/tokens', () => ({
  listTokens: () => listTokens(),
  generateToken: (...args: unknown[]) => generateToken(...args),
}));

const mintToken = vi.fn();
vi.mock('@/lib/token-mint', () => ({ mintToken: (...args: unknown[]) => mintToken(...args) }));

vi.mock('@/lib/key-scope-catalog', () => ({
  getKeyScopeCatalog: () => Promise.resolve({ scopes: [], orgs: [] }),
}));
vi.mock('@/components/dashboard/OnboardingStepContent', () => ({
  OnboardingStepContent: () => null,
}));

const { buildOnboardingSteps } = await import('./onboarding-steps');

const RECORD = { id: 'tok-1', name: 'My first token' };

beforeEach(() => {
  vi.clearAllMocks();
  mintToken.mockResolvedValue({ token: 'lk_rw_x', record: RECORD });
});

describe('buildOnboardingSteps', () => {
  it('auto-mints a first token through mintToken with the onboarding origin, never generateToken', async () => {
    listTokens.mockResolvedValue([]);

    await buildOnboardingSteps({ autoGenerateToken: true });

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(mintToken).toHaveBeenCalledWith('My first token', ['read', 'write'], undefined, 'onboarding');
    expect(generateToken).not.toHaveBeenCalled();
  });

  it('mints nothing when the user already has a token', async () => {
    listTokens.mockResolvedValue([RECORD]);

    await buildOnboardingSteps({ autoGenerateToken: true });

    expect(mintToken).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });
});
