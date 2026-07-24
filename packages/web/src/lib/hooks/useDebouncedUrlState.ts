'use client';

/**
 * useDebouncedUrlState
 *
 * A `useState`-compatible hook for URL-backed state whose *URL write* is
 * debounced, while the value it returns stays instantly responsive.
 *
 * ## Why this exists
 * `useUrlState` writes the URL synchronously on every `setState` call. For a
 * value that changes rapidly — a text search box, a range slider — that means a
 * `router.replace` per keystroke/drag. Each navigation re-renders the route
 * subtree (every component subscribed to `useSearchParams`), which makes the
 * control feel laggy and floods the URL/history with intermediate values.
 * Wrapping the write in `startTransition` only lowers its priority; it does not
 * stop the per-keystroke navigation.
 *
 * This hook decouples the two concerns:
 *   1. **Responsiveness** — the returned value is backed by local `useState`, so
 *      the bound control (and any derived client-side computation like list
 *      filtering) updates synchronously on every change.
 *   2. **Persistence** — the URL param is written on a trailing debounce
 *      (`debounceMs`, default 300ms), so `?key=` only updates once the value
 *      settles. It remains shareable and survives refresh, just like
 *      `useUrlState`.
 *
 * ## External changes (back/forward, shared links)
 * When the URL changes from *outside* this hook — the user hits back/forward,
 * or lands on a shared link — the new URL value is reflected back into the local
 * state. A `lastSynced` ref distinguishes an external change from this hook's
 * own debounced write, so an in-flight edit is never clobbered by the write it
 * just triggered.
 *
 * ## SSR & Suspense
 * Inherits `useUrlState`'s requirements verbatim: it calls `useSearchParams()`
 * transitively, so any component using it MUST sit inside a `<Suspense>`
 * boundary. See `useUrlState` for the full SSR/hydration contract.
 *
 * ## Usage (mirrors useState / useUrlState)
 *
 *   const [query, setQuery] = useDebouncedUrlState('q', '');
 *   <input value={query} onChange={(e) => setQuery(e.target.value)} />
 *   // filter your list off `query` for instant results; ?q= updates 300ms later
 *
 *   // Custom debounce and any useUrlState option pass straight through:
 *   const [q, setQ] = useDebouncedUrlState('q', '', {
 *     debounceMs: 500,
 *     cleanOnPathname: '/lore',
 *   });
 *
 * ## When NOT to use this
 * For state that changes on discrete, deliberate actions (selecting a scope,
 * toggling a panel, opening a lesson) use plain `useUrlState` — debouncing there
 * only adds latency between the click and the shareable URL. Debounce is for
 * high-frequency, continuous input.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  useUrlState,
  serialise,
  type UrlStateDispatch,
  type UseUrlStateOptions,
} from './useUrlState';

export interface UseDebouncedUrlStateOptions extends UseUrlStateOptions {
  /**
   * Trailing debounce, in milliseconds, before the settled value is written to
   * the URL. The returned value updates immediately regardless.
   * @default 300
   */
  debounceMs?: number;
}

export function useDebouncedUrlState<T>(
  key: string,
  defaultValue: T,
  options: UseDebouncedUrlStateOptions = {},
): [T, UrlStateDispatch<T>] {
  const { debounceMs = 300, ...urlOptions } = options;

  // The URL is still the source of truth for persistence/sharing; useUrlState
  // owns all the SSR-safe navigation and optimistic plumbing.
  const [urlValue, setUrlValue] = useUrlState<T>(key, defaultValue, urlOptions);
  const [, startTransition] = useTransition();

  // Responsive local value, seeded from the URL on first render.
  const [localValue, setLocalValue] = useState<T>(urlValue);

  // The last value synced across the local/URL boundary (in either direction).
  // Comparing against it tells an *external* URL change apart from the echo of
  // our own debounced write, so in-progress edits are never clobbered.
  const lastSyncedRef = useRef<T>(urlValue);

  // ── Debounced write: local → URL ─────────────────────────────────────────
  useEffect(() => {
    if (serialise(localValue) === serialise(lastSyncedRef.current)) return;
    const timer = setTimeout(() => {
      lastSyncedRef.current = localValue;
      // Low-priority so the URL navigation never blocks input rendering.
      startTransition(() => setUrlValue(localValue));
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [localValue, debounceMs, setUrlValue, startTransition]);

  // ── External sync: URL → local ───────────────────────────────────────────
  // Fires on back/forward and shared-link loads; skips the echo of our own write.
  useEffect(() => {
    if (serialise(urlValue) !== serialise(lastSyncedRef.current)) {
      lastSyncedRef.current = urlValue;
      setLocalValue(urlValue);
    }
  }, [urlValue]);

  const setState = useCallback<UrlStateDispatch<T>>((valueOrUpdater) => {
    setLocalValue((prev) =>
      typeof valueOrUpdater === 'function'
        ? (valueOrUpdater as (p: T) => T)(prev)
        : valueOrUpdater,
    );
  }, []);

  return [localValue, setState];
}
