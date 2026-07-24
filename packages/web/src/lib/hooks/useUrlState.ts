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
 * ## Optimistic updates
 * URL navigation via `router.replace` is asynchronous: the new search params do
 * not appear in `useSearchParams()` until the router has completed the navigation
 * cycle (a React transition). Without optimistic state, users would see the old
 * value for tens of milliseconds between clicking and the URL updating — causing
 * perceived lag and flicker.
 *
 * This hook solves it with a local `optimistic` state that is updated
 * synchronously on every `setState` call, while the URL write happens in the
 * background. When the URL finally reflects the new value (next render after
 * navigation), `optimistic` is reset to `null` so the URL is once again the
 * source of truth. External URL changes (browser back/forward, direct link
 * visits) are reflected immediately because they change `searchParams`, which
 * resets the optimistic layer.
 *
 * ## Usage (mirrors useState exactly)
 *
 *   const [open, setOpen] = useUrlState('sidebarOpen', false);
 *
 *   const [lessonKey, setLessonKey] = useUrlState<string | null>('lesson', null, {
 *     cleanOnUnmount: true,
 *     cleanOnPathname: ['/dashboard', '/activity'],
 *   });
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

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
   * Navigation method. Use 'push' only when you need the back-button to undo
   * state changes. 'replace' (default) keeps history clean.
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
  // `null` means "use the URL value". Set to a concrete value immediately on
  // setState, then cleared once the URL catches up (i.e. once urlValue changes
  // to match the optimistic value).
  const [optimisticValue, setOptimisticValue] = useState<T | null>(null);

  // Once the URL reflects the optimistic value, drop the optimistic layer.
  useEffect(() => {
    if (optimisticValue !== null && serialise(urlValue) === serialise(optimisticValue)) {
      setOptimisticValue(null);
    }
  }, [urlValue, optimisticValue]);

  // The value exposed to callers: optimistic takes priority while the URL is
  // catching up; falls back to the true URL value otherwise.
  const value = optimisticValue !== null ? optimisticValue : urlValue;

  // ── Navigate ref ───────────────────────────────────────────────────────────
  // Updated synchronously during render (no useEffect) so there is never a
  // stale-closure window where setState uses the wrong navigate function.
  const navigateRef = useRef<ReturnType<typeof useRouter>['push']>(
    navigationMode === 'push' ? router.push : router.replace,
  );
  navigateRef.current = navigationMode === 'push' ? router.push : router.replace;

  // ── setState ───────────────────────────────────────────────────────────────
  const setState = useCallback<UrlStateDispatch<T>>(
    (valueOrUpdater) => {
      const prev = optimisticValue !== null ? optimisticValue : deserialise<T>(searchParams.get(key), defaultValue);
      const next =
        typeof valueOrUpdater === 'function'
          ? (valueOrUpdater as (prev: T) => T)(prev)
          : valueOrUpdater;

      // 1. Optimistic: immediate UI update, no wait for navigation round-trip.
      setOptimisticValue(next);

      // 2. Persist: update the URL asynchronously via the router.
      const url = buildUrl(pathname, searchParams, key, next, defaultValue);
      navigateRef.current(url, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, pathname, key, defaultValue, optimisticValue],
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
