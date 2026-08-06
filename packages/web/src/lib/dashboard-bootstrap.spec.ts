import { describe, it, expect, vi } from 'vitest';
import { resolveDashboardBootstrap } from './dashboard-bootstrap';

interface User {
  id: string;
}
interface Onboarding {
  hasLessons: boolean;
  hasWebhook: boolean;
}

const FALLBACK: Onboarding = { hasLessons: false, hasWebhook: false };
const STATE: Onboarding = { hasLessons: true, hasWebhook: true };
const USER: User = { id: 'u1' };

/** A promise plus the handles to settle it, so a test can control interleaving. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('resolveDashboardBootstrap', () => {
  it('issues the onboarding read before the session read resolves', async () => {
    // The regression this guards: `await getUser()` followed by
    // `await getOnboardingState()`. Under that ordering the onboarding call is
    // not made until the user promise has already settled, so asserting on it
    // while the user promise is still pending is exactly the discriminator.
    const user = deferred<User | null>();
    const getOnboardingState = vi.fn(async () => STATE);

    const pending = resolveDashboardBootstrap<User, Onboarding>({
      getUser: () => user.promise,
      getOnboardingState,
      onboardingFallback: FALLBACK,
    });

    // Let the helper run up to its first await, with getUser still unsettled.
    await Promise.resolve();
    expect(getOnboardingState).toHaveBeenCalledTimes(1);

    user.resolve(USER);
    await expect(pending).resolves.toEqual({ user: USER, onboardingState: STATE });
  });

  it('returns both once the two reads settle', async () => {
    const result = await resolveDashboardBootstrap<User, Onboarding>({
      getUser: async () => USER,
      getOnboardingState: async () => STATE,
      onboardingFallback: FALLBACK,
    });

    expect(result).toEqual({ user: USER, onboardingState: STATE });
  });

  it('returns null when there is no authenticated user', async () => {
    const result = await resolveDashboardBootstrap<User, Onboarding>({
      getUser: async () => null,
      getOnboardingState: async () => STATE,
      onboardingFallback: FALLBACK,
    });

    expect(result).toBeNull();
  });

  it('degrades to the fallback when the onboarding read rejects', async () => {
    const result = await resolveDashboardBootstrap<User, Onboarding>({
      getUser: async () => USER,
      getOnboardingState: async () => {
        throw new Error('postgrest unreachable');
      },
      onboardingFallback: FALLBACK,
    });

    expect(result).toEqual({ user: USER, onboardingState: FALLBACK });
  });

  it('does not leave an unhandled rejection when the caller is redirected away', async () => {
    // The signed-out path never awaits the onboarding promise. Without a
    // rejection handler attached at creation time, a failing read on a
    // signed-out request becomes an unhandled rejection.
    const onboarding = deferred<Onboarding>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const result = await resolveDashboardBootstrap<User, Onboarding>({
        getUser: async () => null,
        getOnboardingState: () => onboarding.promise,
        onboardingFallback: FALLBACK,
      });
      expect(result).toBeNull();

      onboarding.reject(new Error('postgrest unreachable'));
      // Unhandled-rejection detection is end-of-microtask-queue work; give the
      // runtime several turns before concluding nothing fired.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
