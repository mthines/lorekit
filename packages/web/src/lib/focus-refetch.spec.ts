import { describe, it, expect } from 'vitest';
import { FOCUS_REFETCH_COOLDOWN_MS, shouldRefetchOnFocus } from './focus-refetch';

describe('shouldRefetchOnFocus', () => {
  it('refetches the first time the window is focused', () => {
    expect(shouldRefetchOnFocus({ lastRefetchAt: null, now: 1_000 })).toBe(true);
  });

  it('collapses repeated focus events inside the cooldown into one refetch', () => {
    const now = 10_000;
    expect(shouldRefetchOnFocus({ lastRefetchAt: now - 100, now })).toBe(false);
  });

  it('refetches again once the cooldown has elapsed', () => {
    const now = 10_000;
    expect(
      shouldRefetchOnFocus({ lastRefetchAt: now - FOCUS_REFETCH_COOLDOWN_MS, now }),
    ).toBe(true);
  });

  it('honours a caller-supplied cooldown', () => {
    expect(shouldRefetchOnFocus({ lastRefetchAt: 0, now: 500, cooldownMs: 1_000 })).toBe(false);
    expect(shouldRefetchOnFocus({ lastRefetchAt: 0, now: 500, cooldownMs: 100 })).toBe(true);
  });

  it('fails towards refreshing when the clock is unusable', () => {
    // A backwards jump (NTP correction, sleep/wake) or a corrupt timestamp must
    // never wedge the dashboard into never refetching again.
    expect(shouldRefetchOnFocus({ lastRefetchAt: 10_000, now: 1_000 })).toBe(true);
    expect(shouldRefetchOnFocus({ lastRefetchAt: Number.NaN, now: 1_000 })).toBe(true);
    expect(shouldRefetchOnFocus({ lastRefetchAt: Number.POSITIVE_INFINITY, now: 1_000 })).toBe(true);
  });
});
