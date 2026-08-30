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
 * `feature_flag.<key>` = variant. That is what makes "which flags were active
 * for this visitor" and "which experiment arm" answerable retrospectively
 * from the Web Events explorer — see `docs/feature-flags.md` §
 * "Feature flags in telemetry" for why this is a different mechanism than the
 * server-side OTel span hook (`otel-hook.ts`).
 */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { FlagKey, FlagValueMap } from '@lorekit/feature-flags';
import { syncFeatureFlagRumAttributes } from '@/lib/dash0-rum';

interface FeatureFlagsContextValue {
  values: FlagValueMap;
  variants: Readonly<Record<string, string>>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

export interface FeatureFlagsProviderProps {
  /** The full flag map, evaluated server-side — see `getAllServerFlagState()` in `server.ts`. */
  flags: FlagValueMap;
  /** Flag key -> variant, from the SAME evaluation `flags` came from. */
  variants: Readonly<Record<string, string>>;
  children: ReactNode;
}

/** Mount once near the dashboard root, seeded with a server-evaluated flag map. */
export function FeatureFlagsProvider({ flags, variants, children }: FeatureFlagsProviderProps) {
  // Keyed on a stable string, not the `variants` object identity — the
  // dashboard layout builds a fresh object every render, and re-tagging RUM
  // signals with identical content on every navigation would be pure churn.
  const variantsKey = JSON.stringify(variants);
  useEffect(() => {
    syncFeatureFlagRumAttributes(variants);
    // `variantsKey` (not `variants`) is the intentional dependency — content-based,
    // since the dashboard layout builds a fresh `variants` object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantsKey]);

  return (
    <FeatureFlagsContext.Provider value={{ values: flags, variants }}>
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
 * (`if (useFeatureFlag('insights-page')) ...`). For a flag with an active
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
