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
import type { FlagKey, FlagValueMap } from '@lorekit/feature-flags';
import type { JsonValue } from '@lorekit/feature-flags/schema';
// The `/registry` subpath, NOT the package index: the index re-exports
// `client.ts`, which pulls in the Node-only `@openfeature/server-sdk` and
// cannot be evaluated in the browser these stories run in.
import { FLAG_REGISTRY } from '@lorekit/feature-flags/registry';
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
 * Every flag's REGISTRY default (`defaultVariant`'s value), DERIVED from the
 * registry rather than transcribed from it. Stories render outside the
 * dashboard layout, so nothing evaluates a flag server-side for them; this is
 * a plain, deterministic seed rather than a live `evaluateFlag` call, which
 * can't run in the browser anyway (`@openfeature/server-sdk` is Node-only —
 * see `FeatureFlagsProvider.tsx`'s file header). The registry itself is safe
 * to import here: it is plain zod-validated data, and the Node-only SDK lives
 * in `client.ts`/`provider.ts`, which this does not reach.
 *
 * These were two hand-written maps until flipping one flag's `defaultVariant`
 * left them silently describing the old default — a story then depicts a
 * default no environment has. Deriving removes that class of drift outright,
 * which is better than a spec asserting the two copies still agree.
 */
const DEFAULT_FLAG_VALUES = FLAG_REGISTRY.reduce(
  (acc, flag) => {
    // `defaultVariant` is guaranteed to be a key of `variants` by the registry's
    // own zod `superRefine`, so this lookup cannot be `undefined`. The cast is
    // the same one `withFlagVariants` needs below: `FlagValueMap` is a per-key
    // mapped type and `flag.key` is only known to be some member of the union.
    acc[flag.key as FlagKey] = flag.variants[flag.defaultVariant] as JsonValue;
    return acc;
  },
  {} as Record<FlagKey, JsonValue>,
) as FlagValueMap;

const DEFAULT_FLAG_VARIANTS: Readonly<Record<string, string>> = Object.fromEntries(
  FLAG_REGISTRY.map((flag) => [flag.key, flag.defaultVariant]),
);

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

/**
 * The registry defaults with named flags forced ON — for a story of a surface
 * that is gated OFF by default.
 *
 * Takes VARIANT keys, not values, because a copy-and-suffix resolver dispatches
 * on the variant; the boolean value is derived from it here so the two halves of
 * the provider cannot disagree in a story the way they could if each were seeded
 * by hand. Only `boolean` flags are expressible this way, which is every flag in
 * the registry today — a `string`/`object` flag would need its value passed too,
 * and this deliberately does not pretend otherwise.
 */
export function withFlagVariants(overrides: Partial<Record<FlagKey, string>>): Decorator {
  const values: FlagValueMap = { ...DEFAULT_FLAG_VALUES };
  const variants: Record<string, string> = { ...DEFAULT_FLAG_VARIANTS };
  for (const [key, variant] of Object.entries(overrides) as [FlagKey, string][]) {
    variants[key] = variant;
    // Every flag in the registry is `boolean`, so the value IS "is this the `on`
    // arm" — which is also why an unknown variant seeds `false`, matching the
    // resolver's `default → off`. The cast is needed because `FlagValueMap` is a
    // per-key mapped type and `key` is only known to be some member of the union.
    (values as Record<FlagKey, boolean>)[key] = variant === 'on';
  }
  const Wrapped: Decorator = (Story) => (
    <FeatureFlagsProvider flags={values} variants={variants}>
      <Story />
    </FeatureFlagsProvider>
  );
  return Wrapped;
}
