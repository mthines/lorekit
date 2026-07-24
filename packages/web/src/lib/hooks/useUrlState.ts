'use client';

/**
 * useUrlState
 *
 * A useState-compatible hook that persists state in the URL search params.
 *
 * Features:
 * - Reads from / writes to URLSearchParams via Next.js useSearchParams / useRouter.
 * - Serialises via JSON – any JSON-serialisable value is supported.
 * - When the value equals defaultValue, the param is removed to keep URLs clean.
 * - `cleanOnUnmount`: removes the param when the owning component unmounts.
 * - `cleanOnPathname`: removes the param whenever the current pathname does not
 *   match the provided path(s). Useful for scoping state to one section of the app.
 * - Defaults to `router.replace` so back-button history isn't polluted.
 *
 * Usage (mirrors useState exactly):
 *
 *   const [open, setOpen] = useUrlState('sidebarOpen', false);
 *
 *   const [lessonKey, setLessonKey] = useUrlState<string | null>('lesson', null, {
 *     cleanOnUnmount: true,
 *     cleanOnPathname: ['/dashboard', '/activity'],
 *   });
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
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

// ── helpers ───────────────────────────────────────────────────────────────────

function toAbsolute(p: string) {
  return p.startsWith('/') ? p : `/${p}`;
}

function serialise<T>(value: T): string {
  return JSON.stringify(value);
}

function deserialise<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

  // Keep a ref to the navigate function. Updated synchronously during render
  // so the ref is always fresh when setState is called within the same cycle.
  const navigateRef = useRef<ReturnType<typeof useRouter>['push']>(
    navigationMode === 'push' ? router.push : router.replace,
  );
  // Synchronous update (no useEffect) ensures there is never a stale-closure window.
  navigateRef.current = navigationMode === 'push' ? router.push : router.replace;

  // Current value decoded from URL. Re-computes only when `searchParams` or
  // `key` change – unrelated param changes don't trigger a re-render of the
  // consumer. `defaultValue` is intentionally omitted from deps: it should be
  // a stable literal/constant defined outside the render cycle; if it isn't,
  // the caller should memoize it themselves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo<T>(() => deserialise<T>(searchParams.get(key), defaultValue), [searchParams, key]);

  const setState = useCallback<UrlStateDispatch<T>>(
    (valueOrUpdater) => {
      const next =
        typeof valueOrUpdater === 'function'
          ? (valueOrUpdater as (prev: T) => T)(
              deserialise<T>(searchParams.get(key), defaultValue),
            )
          : valueOrUpdater;

      const params = new URLSearchParams(searchParams.toString());

      if (serialise(next) === serialise(defaultValue)) {
        params.delete(key);
      } else {
        params.set(key, serialise(next));
      }

      const qs = params.toString();
      navigateRef.current(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, pathname, key, defaultValue],
  );

  // ── cleanOnPathname effect ─────────────────────────────────────────────────
  useEffect(() => {
    if (!cleanOnPathname || !searchParams.has(key)) return;

    const allowed = (Array.isArray(cleanOnPathname) ? cleanOnPathname : [cleanOnPathname]).map(
      toAbsolute,
    );

    const current = toAbsolute(pathname);
    const isAllowed = allowed.some((p) => current === p || current.startsWith(`${p}/`));

    if (!isAllowed) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(key);
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    }
  }, [pathname, cleanOnPathname, key, searchParams, router]);

  // ── cleanOnUnmount effect ──────────────────────────────────────────────────
  // Refs capture the latest values so the cleanup closure never stale-closes.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  useEffect(() => {
    if (!cleanOnUnmount) return;
    return () => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      if (!params.has(key)) return;
      params.delete(key);
      const qs = params.toString();
      router.replace(`${pathnameRef.current}${qs ? `?${qs}` : ''}`, { scroll: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanOnUnmount, key]);

  return [value, setState];
}
