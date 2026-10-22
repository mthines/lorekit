'use client';

/**
 * useUrlState
 *
 * A useState-compatible hook that persists state in the URL search params.
 *
 * ## SSR behaviour
 * Next.js App Router renders components without access to search params on the
 * server (the `useSearchParams()` hook returns an empty object server-side).
 * Components using this hook MUST be wrapped in a `<Suspense>` boundary so that
 * Next.js renders a shell on the server and fills in the real URL-derived value
 * on the client, avoiding hydration mismatches.
 *
 * ## Writing the URL
 * `setState` writes the address bar with `window.history` ({@link writeParamToHistory})
 * a microtask after it returns — before any paint — so a reload right after a choice keeps it.
 * A `router.replace` committed the URL only after a server render — seconds on a slow backend.
 *
 * ## Optimistic updates
 * The address bar changes synchronously, but Next.js applies the change to
 * `useSearchParams()` inside a React transition, a render later. Without
 * optimistic state, readers would show the old value for that render — causing
 * perceived lag and flicker.
 *
 * This hook solves it with a local `optimistic` state that is updated
 * synchronously on every `setState` call, alongside the URL write. When
 * `useSearchParams()` reflects the new value (the next render),
 * `optimistic` is reset to `UNSET` so the URL is once again the source of
 * truth.
 *
 * The optimistic value is shared by KEY across every mounted instance
 * (`url-state-optimistic.ts`), not held per instance: a write from one
 * component (the detail panel adding a filter) shows up at once in every other
 * component reading the same param (the Explorer's filter bar and list), rather
 * than only after the navigation lands.
 *
 * ## Usage (mirrors useState exactly)
 *
 *   const [open, setOpen] = useUrlState('sidebarOpen', false);
 *
 *   const [lessonKey, setLessonKey] = useUrlState<string | null>('lesson', null, {
 *     cleanOnUnmount: true,
 *     cleanOnPathname: ['/lore', '/activity'],
 *   });
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  UNSET,
  readOptimistic,
  retainOptimistic,
  settleOptimistic,
  subscribeOptimistic,
  writeOptimistic,
  type Unset,
} from './url-state-optimistic';

// ── Optimistic sentinel ────────────────────────────────────────────────────────
// `UNSET` (from `url-state-optimistic.ts`) means "no optimistic value". Using
// `null` breaks when T itself is `string | null` (e.g.
// `useUrlState<string | null>('org', null)`) because a legitimate `null` value is
// indistinguishable from the "not set" sentinel, which causes the optimistic
// layer to never clear and eventually triggers a React invalid-hook call (React
// error #310) on the /settings page. A Symbol can never equal a real value.

export type UrlStateDispatch<S> = (value: S | ((prev: S) => S)) => void;

export interface UseUrlStateOptions {
  /**
   * Remove the param from the URL when the component unmounts.
   * @default false
   */
  cleanOnUnmount?: boolean;
  /**
   * Pathname(s) on which this param is valid. When the user navigates away from
   * all listed paths the param is immediately cleaned from the URL.
   * Prefix matching: '/lore' also matches '/lore/edit'.
   */
  cleanOnPathname?: string | string[];
  /**
   * How a write enters the browser history. Use 'push' only when you need the
   * back-button to undo state changes (`history.pushState`). 'replace'
   * (default, `history.replaceState`) keeps history clean.
   * @default 'replace'
   */
  navigationMode?: 'push' | 'replace';
}

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/** Normalise a path so it always starts with '/'. */
export function toAbsolute(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

/** JSON-serialise a value to a URL param string. */
export function serialise<T>(value: T): string {
  return JSON.stringify(value);
}

/** JSON-deserialise a URL param string, returning `fallback` on null or parse error. */
export function deserialise<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Build the new URL string after updating a single search param.
 * When `next` equals `defaultValue` (by JSON equality), the param is removed
 * to keep URLs clean.
 */
export function buildUrl<T>(
  pathname: string,
  currentParams: URLSearchParams,
  key: string,
  next: T,
  defaultValue: T,
): string {
  const params = new URLSearchParams(currentParams.toString());
  if (serialise(next) === serialise(defaultValue)) {
    params.delete(key);
  } else {
    params.set(key, serialise(next));
  }
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ''}`;
}

// One handler that sets several push-mode keys (FilterBar's "Clear all") is one
// user step, so only its first URL-changing write pushes; the rest replace that
// entry. Cleared on the next microtask, once the handler has returned.
let pushedThisTask = false;

function notePush(): void {
  if (pushedThisTask) return;
  pushedThisTask = true;
  queueMicrotask(() => {
    pushedThisTask = false;
  });
}

/** The parts of `window` a URL write touches — passed in so the write is testable without a DOM. */
export interface HistoryWindow {
  location: Pick<Location, 'pathname' | 'search'>;
  history: Pick<History, 'pushState' | 'replaceState'>;
}

/**
 * Write one param to the address bar, synchronously, and return the URL written.
 * @param mode - `push` adds a Back step when the value changes, once per task; `replace` never does.
 * @returns The URL now in the address bar.
 */
export function writeParamToHistory<T>(
  win: HistoryWindow,
  key: string,
  next: T,
  defaultValue: T,
  mode: 'push' | 'replace',
): string {
  // The LIVE location, not a render's useSearchParams() snapshot: a second
  // write in the same tick then starts from the URL the first just wrote.
  const params = new URLSearchParams(win.location.search);
  const nextRaw = serialise(next) === serialise(defaultValue) ? null : serialise(next);
  // Re-setting the current value pushes nothing, as router.push dedupes it.
  const changed = params.get(key) !== nextRaw;
  const url = buildUrl(win.location.pathname, params, key, next, defaultValue);
  // window.history, not the router: Next.js syncs it into useSearchParams()
  // without the server render a router.replace waits on before the URL commits.
  if (mode === 'push' && changed && !pushedThisTask) {
    win.history.pushState(null, '', url);
    notePush();
  } else {
    win.history.replaceState(null, '', url);
  }
  return url;
}

/**
 * Whether `pathname` matches any of the `allowed` paths (exact or prefix match).
 * All inputs are normalised to start with '/'.
 */
export function isPathnameAllowed(pathname: string, allowed: string | string[]): boolean {
  const normalised = toAbsolute(pathname);
  const allowedList = (Array.isArray(allowed) ? allowed : [allowed]).map(toAbsolute);
  return allowedList.some(
    (p) => p === '/' || normalised === p || normalised.startsWith(`${p}/`),
  );
}

// ── hook ──────────────────────────────────────────────────────────────────────

export function useUrlState<T>(
  key: string,
  defaultValue: T,
  options: UseUrlStateOptions = {},
): [T, UrlStateDispatch<T>] {
  const { cleanOnUnmount = false, cleanOnPathname, navigationMode = 'replace' } = options;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── True URL value ─────────────────────────────────────────────────────────
  // Re-derives from `searchParams` whenever the router navigation completes.
  // `defaultValue` is intentionally omitted from deps: callers are expected to
  // pass a stable reference. Mutable defaults should be memoized at the call site.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const urlValue = useMemo<T>(() => deserialise<T>(searchParams.get(key), defaultValue), [searchParams, key]);

  // ── Optimistic state ───────────────────────────────────────────────────────
  // `UNSET` means "use the URL value". Set to a concrete value immediately on
  // setState, then cleared once the URL catches up (i.e. once urlValue changes
  // to match the optimistic value).
  // NOTE: Do NOT use `null` as the sentinel — when T includes `null` (e.g.
  // `string | null`) the sentinel collides with a legitimate state value,
  // preventing the optimistic layer from ever clearing (React error #310).
  // Shared by key across instances — see `url-state-optimistic.ts`. The server
  // snapshot is always UNSET: nothing has been written before hydration.
  const getOptimistic = useCallback(() => readOptimistic(key) as T | Unset, [key]);
  const getServerOptimistic = useCallback((): T | Unset => UNSET, []);
  const optimisticValue = useSyncExternalStore<T | Unset>(subscribeOptimistic, getOptimistic, getServerOptimistic);

  // Count this instance as a reader, so the last one to unmount drops a write
  // that never landed instead of leaving it pending for the next page.
  useEffect(() => retainOptimistic(key), [key]);

  // Once the URL reflects the optimistic value — or the reader has left the
  // page it was written on — drop the optimistic layer.
  useEffect(() => {
    if (optimisticValue === UNSET) return;
    settleOptimistic(key, { pathname, urlMatches: serialise(urlValue) === serialise(optimisticValue) });
  }, [key, pathname, urlValue, optimisticValue]);

  // The value exposed to callers: optimistic takes priority while the URL is
  // catching up; falls back to the true URL value otherwise.
  const value = optimisticValue !== UNSET ? optimisticValue : urlValue;

  // ── setState ───────────────────────────────────────────────────────────────
  const setState = useCallback<UrlStateDispatch<T>>(
    (valueOrUpdater) => {
      // Read the store at call time, not the render's snapshot: another instance
      // may have written since this one last rendered.
      const pendingValue = readOptimistic(key) as T | Unset;
      const prev = pendingValue !== UNSET ? pendingValue : deserialise<T>(searchParams.get(key), defaultValue);
      const next =
        typeof valueOrUpdater === 'function'
          ? (valueOrUpdater as (prev: T) => T)(prev)
          : valueOrUpdater;

      // 1. Optimistic: immediate UI update in every instance reading `key`,
      //    before `useSearchParams()` catches up a render later.
      writeOptimistic(key, next, pathname);

      // 2. Persist to the address bar, a microtask later: on a hard load Next.js
      //    patches window.history in an effect that runs after child mount effects.
      queueMicrotask(() => writeParamToHistory(window, key, next, defaultValue, navigationMode));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, pathname, key, defaultValue, navigationMode],
  );

  // ── cleanOnPathname effect ─────────────────────────────────────────────────
  useEffect(() => {
    if (!cleanOnPathname || !searchParams.has(key)) return;
    if (!isPathnameAllowed(pathname, cleanOnPathname)) {
      const url = buildUrl(pathname, searchParams, key, defaultValue, defaultValue);
      router.replace(url, { scroll: false });
    }
  }, [pathname, cleanOnPathname, key, searchParams, router, defaultValue]);

  // ── cleanOnUnmount effect ──────────────────────────────────────────────────
  // Refs capture latest values so the cleanup closure is always current.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;

  useEffect(() => {
    if (!cleanOnUnmount) return;
    return () => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      if (!params.has(key)) return;
      const url = buildUrl(
        pathnameRef.current,
        searchParamsRef.current,
        key,
        defaultValueRef.current,
        defaultValueRef.current,
      );
      router.replace(url, { scroll: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanOnUnmount, key]);

  return [value, setState];
}
