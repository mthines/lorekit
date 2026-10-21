'use client';

/**
 * Client-side feature-flag reads for `packages/web`.
 *
 * ## Why there is no independent client-side evaluation
 *
 * `@lorekit/feature-flags`' `evaluateFlag` is built on `@openfeature/server-sdk`
 * — Node-only, cannot run in the browser (OpenFeature ships a SEPARATE
 * `@openfeature/web-sdk` for that, which this app does not depend on). Even
 * setting that aside, re-evaluating independently in the browser would risk a
 * hydration mismatch: the server renders based on ITS evaluation, and if the
 * client computed its own — even with identical bucketing logic — the two
 * would only agree if every input (targeting key, override cookie, registry
 * version) was threaded through perfectly. Simplest and safest: evaluate
 * ONCE, server-side (`server.ts`), and hand the resolved VALUES down through
 * this context. `useFeatureFlag` is a plain read with no fetch, no loading
 * state, and no way to disagree with the Server Component that rendered it.
 *
 * The cost: a flag value is fixed for the lifetime of the current page's RSC
 * payload. Changing it (e.g. via the developer override page) needs a fresh
 * server render — `router.refresh()` — not a client-side re-evaluation. See
 * `DeveloperFlagsPanel.tsx`.
 *
 * ## RUM: this is also the ONE place feature flags reach telemetry from the browser
 *
 * `variants` — flag key -> variant KEY string, from `getAllServerFlagState()`
 * (`server.ts`) — is forwarded to `syncFeatureFlagRumAttributes`
 * (`lib/dash0-rum.ts`) on mount and whenever it changes, so every subsequent
 * RUM signal (page view, click, custom event) in this session carries
 * `feature_flag.<key>` = variant, and `reasons` beside it as
 * `lorekit.feature_flag.reason.<key>` = `static` | `split` | `override`. That is what makes "which flags were active
 * for this visitor" and "which experiment arm" answerable retrospectively
 * from the Web Events explorer — see `docs/feature-flags.md` §
 * "Feature flags in telemetry" for why this is a different mechanism than the
 * server-side OTel span hook (`otel-hook.ts`).
 *
 * ## Exposure: who actually reached a flagged surface
 *
 * Every RUM signal carries every flag, so "carries `feature_flag.x = on`" is not
 * "saw the `on` arm". {@link useFeatureFlagExposure}, called from a flag's
 * resolver, records `feature_flag.exposed` once per mount in BOTH arms — the
 * population an experiment compares.
 */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { FlagKey, FlagValueMap } from '@lorekit/feature-flags';
import { syncFeatureFlagRumAttributes } from '@/lib/dash0-rum';
import { track } from '@/lib/analytics/track';

interface FeatureFlagsContextValue {
  values: FlagValueMap;
  variants: Readonly<Record<string, string>>;
  reasons: Readonly<Record<string, string>>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

export interface FeatureFlagsProviderProps {
  /** The full flag map, evaluated server-side — see `getAllServerFlagState()` in `server.ts`. */
  flags: FlagValueMap;
  /** Flag key -> variant, from the SAME evaluation `flags` came from. */
  variants: Readonly<Record<string, string>>;
  /** Flag key -> how that variant was decided (`static`, `split`, `override`), from the same evaluation. */
  reasons: Readonly<Record<string, string>>;
  children: ReactNode;
}

/** Mount once near the dashboard root, seeded with a server-evaluated flag map. */
export function FeatureFlagsProvider({ flags, variants, reasons, children }: FeatureFlagsProviderProps) {
  // Keyed on a stable string, not the `variants` object identity — the
  // dashboard layout builds a fresh object every render, and re-tagging RUM
  // signals with identical content on every navigation would be pure churn.
  const stateKey = JSON.stringify([variants, reasons]);
  useEffect(() => {
    syncFeatureFlagRumAttributes(variants, reasons);
    // `stateKey` (not the objects) is the intentional dependency — content-based,
    // since the dashboard layout builds fresh objects every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

  return (
    <FeatureFlagsContext.Provider value={{ values: flags, variants, reasons }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

function useFeatureFlagsContext(): FeatureFlagsContextValue {
  const context = useContext(FeatureFlagsContext);
  if (context === null) {
    throw new Error('useFeatureFlag/useFeatureFlagVariant must be used within a <FeatureFlagsProvider>.');
  }
  return context;
}

/**
 * Read one flag's server-evaluated VALUE from a Client Component.
 *
 * Throws outside a `FeatureFlagsProvider` (a missing provider is a wiring bug
 * — the same "fail loudly" choice `evaluateFlag` itself makes for an unknown
 * flag key) rather than silently returning `undefined`.
 *
 * For a boolean flag with no experiment, this is almost always what you want
 * (`if (useFeatureFlag('retention-policies')) ...`). For a flag with an active
 * experiment where each arm should be its OWN component — the copy-and-suffix
 * convention in `packages/feature-flags/CLAUDE.md` — use
 * {@link useFeatureFlagVariant} instead, which returns the variant KEY
 * ("control"/"treatment") rather than the resolved value.
 */
export function useFeatureFlag<K extends FlagKey>(key: K): FlagValueMap[K] {
  return useFeatureFlagsContext().values[key];
}

/**
 * Read one flag's server-evaluated VARIANT KEY (`"control"`, `"treatment"`,
 * `"beta"`) rather than its resolved value — the switch a copy-and-suffix
 * resolver component dispatches on. See `packages/feature-flags/CLAUDE.md`
 * § "UI variants: copy-and-suffix, never inline branching".
 */
export function useFeatureFlagVariant(key: FlagKey): string {
  return useFeatureFlagsContext().variants[key];
}

/**
 * How one flag's variant was decided — `static` (the default), `split` (an
 * experiment assigned it) or `override` (a developer forced it) — spelled as
 * server spans spell `feature_flag.result.reason`. `unknown` when the
 * evaluation reported none.
 */
export function useFeatureFlagReason(key: FlagKey): string {
  return useFeatureFlagsContext().reasons[key] ?? 'unknown';
}

/**
 * Record that this user reached the surface `key` gates: one
 * `feature_flag.exposed` event per mount, and again if the variant changes.
 *
 * Call it from the flag's RESOLVER, not from one arm — the control arm's
 * exposures are half of the comparison.
 *
 * Deferred one task on purpose. React runs a child's effects before its
 * parents', so on a full page load an immediate event would leave before
 * `Dash0Provider` swaps the anonymous id for the user and before this
 * provider's own RUM sync — counting browsers instead of users. One
 * `setTimeout` lands after every effect of the commit.
 */
export function useFeatureFlagExposure(key: FlagKey): void {
  const variant = useFeatureFlagVariant(key);
  const reason = useFeatureFlagReason(key);
  useEffect(() => {
    const timer = setTimeout(() => track({ name: 'feature_flag.exposed', flagKey: key, variant, reason }), 0);
    return () => clearTimeout(timer);
  }, [key, variant, reason]);
}
