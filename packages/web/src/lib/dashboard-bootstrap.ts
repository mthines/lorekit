/**
 * The dashboard layout's two server-side reads, and the order they happen in.
 *
 * The layout needs a session (`auth.getUser()`) and the onboarding completion
 * counts (`getOnboardingState()`). It used to `await` the first and then
 * `await` the second, which made every dashboard render pay both round-trips
 * end to end even though the second does not depend on the first.
 *
 * The ordering is the whole decision, so it lives here rather than inline in
 * the layout: it is dependency-injected and therefore node-testable, where an
 * async server component is not (`packages/web/vitest.config.ts` collects
 * `src/**\/*.spec.ts` only, and this repo's convention is that decision logic
 * belongs in a pure helper with a test home).
 *
 * Two invariants this protects, both easy to lose in a one-line "simplification":
 *
 *  - The onboarding read is ISSUED BEFORE the session read is awaited, so the
 *    two overlap. Awaiting `getUser()` first re-serialises them.
 *  - The onboarding promise carries its own rejection handler from the moment
 *    it is created. On the signed-out path the caller redirects and never
 *    awaits it, so an unhandled rejection would otherwise surface as a process
 *    warning (and, under `--unhandled-rejections=throw`, worse) on exactly the
 *    request that is already going somewhere else.
 *
 * Issuing the onboarding counts before the session is verified is safe, and
 * that is a property of the caller's client, not of this module: the counts go
 * through the RLS-scoped server client built from the request's cookies, so
 * Postgres decides what they can see. An absent or expired session reads
 * nothing, and the result is discarded on the redirect path regardless.
 */

export interface DashboardBootstrapDeps<TUser, TOnboarding> {
  /** Resolves the request's authenticated user, or null when there is none. */
  getUser: () => Promise<TUser | null>;
  /** Resolves the onboarding completion signals. */
  getOnboardingState: () => Promise<TOnboarding>;
  /**
   * Used when `getOnboardingState` rejects. Onboarding state is progress
   * decoration, so a failed read degrades the badge rather than the layout.
   *
   * The guarantee is scoped to THIS helper's caller, not to every consumer of
   * the underlying read. A page that awaits `getOnboardingState()` itself
   * still surfaces the rejection — `app/(dashboard)/overview/page.tsx` does
   * exactly that, and because the read is React-`cache()`d it awaits the same
   * memoised rejection this fallback absorbed for the layout.
   */
  onboardingFallback: TOnboarding;
}

export interface DashboardBootstrap<TUser, TOnboarding> {
  user: TUser;
  onboardingState: TOnboarding;
}

/**
 * Resolve the dashboard layout's server-side prerequisites, overlapping the
 * two reads. Returns null when the request has no authenticated user — the
 * caller is responsible for the redirect, which needs `next/navigation` and
 * request headers this module deliberately does not reach for.
 */
export async function resolveDashboardBootstrap<TUser, TOnboarding>(
  deps: DashboardBootstrapDeps<TUser, TOnboarding>,
): Promise<DashboardBootstrap<TUser, TOnboarding> | null> {
  // Started first and deliberately not awaited yet — this is the overlap.
  const onboarding = deps.getOnboardingState().catch((error: unknown) => {
    // The rejection is swallowed so the layout still renders, and so the
    // signed-out path — which returns below without ever awaiting this promise
    // — cannot produce an unhandled rejection. It is LOGGED because swallowing
    // it silently makes a real backend failure indistinguishable from a
    // genuinely empty account: both render the "nothing done" badge.
    console.error('[resolveDashboardBootstrap] onboarding read failed:', error);
    return deps.onboardingFallback;
  });

  const user = await deps.getUser();
  if (!user) return null;

  return { user, onboardingState: await onboarding };
}
