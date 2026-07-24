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

  // Current value decoded from URL. Re-computes only when `searchParams` or
  // `key` change – unrelated param changes don't trigger a re-render of the
  // value returned from this hook.
  const value = useMemo<T>(
    () => deserialise<T>(searchParams.get(key), defaultValue),
    // defaultValue is intentionally excluded: it is expected to be a stable
    // literal or constant defined outside the render cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, key],
  );

  // Keep a ref to the navigate fn so setState doesn't need to be recreated when
  // navigationMode changes between renders.
  const navigateRef = useRef<typeof router.push | typeof router.replace>(
    navigationMode === 'push' ? router.push : router.replace,
  );
  useEffect(() => {
    navigateRef.current = navigationMode === 'push' ? router.push : router.replace;
  }, [router, navigationMode]);

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
  // Use refs so the cleanup closure always sees the latest values without
  // being re-registered on every render.
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
    // Only depends on stable values – key and cleanOnUnmount are call-site constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanOnUnmount, key]);

  return [value, setState];
}
