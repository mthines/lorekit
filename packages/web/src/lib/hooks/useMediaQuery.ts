'use client';

import { useSyncExternalStore } from 'react';

/**
 * Media-query subscription backed by a single shared listener per query.
 *
 * Why not `useState` + an effect per call: that spins up a separate
 * `MediaQueryList` and `change` listener for every component instance, all
 * watching the same breakpoint. Instead, one `MediaQueryList` per distinct query
 * string is created lazily and shared through a module-level registry; every
 * consumer subscribes to it via `useSyncExternalStore`, so N components that ask
 * for the same breakpoint cost ONE listener, not N.
 *
 * `useSyncExternalStore` also removes the old `false`-then-correct flash: the
 * client snapshot reads `matches` synchronously on first render, while the
 * server snapshot is a stable `false` (there is no `window` to measure) — the
 * hook is SSR-safe and used only by client components that mount on interaction.
 *
 * This is JS, deliberately: a responsive choice that drives JavaScript — Framer
 * Motion `initial`/`animate` variants, `drag` enablement, or which single DOM
 * tree to mount — cannot be expressed with Tailwind's `md:` classes (CSS only),
 * and `matchMedia` re-renders only when the breakpoint is crossed, never on
 * every resize.
 */

interface Entry {
  mql: MediaQueryList;
  subscribers: Set<() => void>;
  listener: () => void;
}

const registry = new Map<string, Entry>();

function getOrCreateEntry(query: string): Entry {
  let entry = registry.get(query);
  if (!entry) {
    const mql = window.matchMedia(query);
    const subscribers = new Set<() => void>();
    // ONE `change` listener per query, fanned out to every subscriber.
    const listener = () => subscribers.forEach((cb) => cb());
    mql.addEventListener('change', listener);
    entry = { mql, subscribers, listener };
    registry.set(query, entry);
  }
  return entry;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      // Runs client-side only; safe to touch `window` here.
      const entry = getOrCreateEntry(query);
      entry.subscribers.add(onStoreChange);
      return () => {
        entry.subscribers.delete(onStoreChange);
        // Tear the shared listener down once the last consumer unsubscribes.
        if (entry.subscribers.size === 0) {
          entry.mql.removeEventListener('change', entry.listener);
          registry.delete(query);
        }
      };
    },
    () => registry.get(query)?.mql.matches ?? window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Below Tailwind's `md` (768px). The single source of truth for "mobile", so
 * every `useIsMobile()` consumer shares the exact same query string — and thus
 * the exact same shared listener.
 */
export const MOBILE_QUERY = '(max-width: 767px)';

/** Whether the viewport is below the `md` breakpoint. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
