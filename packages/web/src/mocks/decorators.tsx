/**
 * Storybook decorators for the MSW-mocked, React-Query-backed full-page stories.
 *
 * - {@link withQueryClient} wraps a story in a fresh, test-tuned
 *   `QueryClientProvider` so the app's real hooks resolve against the MSW-mocked
 *   responses deterministically (retries off, no background refetch, no cache
 *   bleed between stories).
 * - {@link withFrozenClock} pins `Date` to a fixed instant so every
 *   time-relative render (freshness labels, trend chips, the contribution
 *   heatmap) snapshots identically across runs.
 */
import type { Decorator } from '@storybook/nextjs-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { FlagValueMap } from '@lorekit/feature-flags';
import { MemorySidebarProvider } from '@/components/providers/MemorySidebarProvider';
import { ExplorerResultsProvider } from '@/components/providers/ExplorerResultsProvider';
import { FeatureFlagsProvider } from '@/components/providers/FeatureFlagsProvider';

/**
 * Wrap a story in a fresh `QueryClientProvider` tuned for deterministic tests.
 *
 * A new client is created per story mount (via `useState`), so no query cache
 * leaks between stories. Retries and every refetch trigger are disabled and
 * data is never considered stale, so a hook resolves exactly once against the
 * MSW handler and the render settles immediately — no spinner captured
 * mid-flight.
 */
function TestQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnMount: false,
            refetchOnReconnect: false,
            staleTime: Infinity,
            gcTime: Infinity,
          },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export const withQueryClient: Decorator = (Story) => (
  <TestQueryProvider>
    <Story />
  </TestQueryProvider>
);

/**
 * Freeze `Date` to `fixedIso` for the story's render.
 *
 * The dashboard reads `new Date()` during render (trend windows, freshness
 * labels, the heatmap grid — whose columns are counted back from today), so
 * the clock must be pinned before the
 * story paints. Only the zero-argument constructor and `Date.now()` are
 * overridden; `new Date(someArg)` still parses normally, so fixture timestamps
 * are unaffected. The override is a subclass assignment on `globalThis.Date`;
 * stories that render no date are untouched by it.
 */
export function withFrozenClock(fixedIso: string): Decorator {
  const fixed = new Date(fixedIso).getTime();

  const FrozenClock: Decorator = (Story) => {
    // Idempotent: only install once per worker (all data stories freeze to the
    // same instant). A Proxy over `Date` forwards every real construction/method
    // except the zero-arg constructor and `Date.now()`, which return the fixed
    // instant — so `new Date(someIso)` still parses fixtures normally.
    if (!(globalThis.Date as unknown as { __frozen?: boolean }).__frozen) {
      const RealDate = globalThis.Date;
      const proxy = new Proxy(RealDate, {
        construct(target, args) {
          return args.length === 0
            ? new target(fixed)
            : new (target as unknown as { new (...a: unknown[]): Date })(...args);
        },
        get(target, prop, receiver) {
          if (prop === '__frozen') return true;
          if (prop === 'now') return () => fixed;
          return Reflect.get(target, prop, receiver);
        },
      });
      globalThis.Date = proxy as unknown as DateConstructor;
    }
    return <Story />;
  };

  return FrozenClock;
}

/**
 * Provide the client context the `/lore` page tree needs when rendered outside
 * the dashboard layout. `useMemorySidebar()` throws without its provider, and
 * `LoreExplorer` reads it to drive the lesson detail sheet. The sheet only
 * mounts once a lesson is opened, so at rest this adds no visible DOM to the
 * snapshot.
 */
export const withMemorySidebar: Decorator = (Story) => (
  <MemorySidebarProvider>
    <Story />
  </MemorySidebarProvider>
);

/**
 * Provide the client context `LoreExplorer` needs when rendered outside the
 * dashboard layout's `ExplorerResultsProvider` (see that component's
 * docblock). `useExplorerResults()` throws without it — in the real app the
 * dashboard layout wraps every page, but a page story mounts `/lore` on its
 * own, so it needs the same wrapper here. Reporting into it is a no-op with
 * nothing else listening, so this adds no visible DOM to the snapshot.
 */
export const withExplorerResults: Decorator = (Story) => (
  <ExplorerResultsProvider>
    <Story />
  </ExplorerResultsProvider>
);

/**
 * Every flag's REGISTRY default (`defaultVariant`'s value) — see
 * `packages/feature-flags/src/registry.ts`. Stories render outside the
 * dashboard layout, so nothing evaluates a flag server-side for them; this is
 * a plain, deterministic seed rather than a live `evaluateFlag` call, which
 * can't run in the browser anyway (`@openfeature/server-sdk` is Node-only —
 * see `FeatureFlagsProvider.tsx`'s file header).
 */
const DEFAULT_FLAG_VALUES: FlagValueMap = {
  'insights-page': false,
  'retention-policies': false,
  'lore-explorer-instruments': false,
};

const DEFAULT_FLAG_VARIANTS: Readonly<Record<string, string>> = {
  'insights-page': 'off',
  'retention-policies': 'off',
  'lore-explorer-instruments': 'off',
};

/**
 * Seed `FeatureFlagsProvider` with the registry's defaults so components
 * reading `useFeatureFlag`/`useFeatureFlagVariant` (e.g. `LoreExplorer`'s
 * `lore-explorer-instruments` gate) resolve instead of throwing "must be
 * used within a <FeatureFlagsProvider>" when rendered outside the dashboard
 * layout, which is the only place a real provider is mounted.
 */
export const withFeatureFlags: Decorator = (Story) => (
  <FeatureFlagsProvider flags={DEFAULT_FLAG_VALUES} variants={DEFAULT_FLAG_VARIANTS}>
    <Story />
  </FeatureFlagsProvider>
);
