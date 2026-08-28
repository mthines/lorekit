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
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { FlagKey, FlagValueMap } from '@lorekit/feature-flags';

const FeatureFlagsContext = createContext<FlagValueMap | null>(null);

export interface FeatureFlagsProviderProps {
  /** The full flag map, evaluated server-side — see `getAllServerFlags()` in `server.ts`. */
  flags: FlagValueMap;
  children: ReactNode;
}

/** Mount once near the dashboard root, seeded with a server-evaluated flag map. */
export function FeatureFlagsProvider({ flags, children }: FeatureFlagsProviderProps) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

/**
 * Read one flag's server-evaluated value from a Client Component.
 *
 * Throws outside a `FeatureFlagsProvider` (a missing provider is a wiring bug
 * — the same "fail loudly" choice `evaluateFlag` itself makes for an unknown
 * flag key) rather than silently returning `undefined`.
 */
export function useFeatureFlag<K extends FlagKey>(key: K): FlagValueMap[K] {
  const flags = useContext(FeatureFlagsContext);
  if (flags === null) {
    throw new Error('useFeatureFlag must be used within a <FeatureFlagsProvider>.');
  }
  return flags[key];
}
