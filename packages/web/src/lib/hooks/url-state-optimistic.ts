/**
 * The optimistic layer behind {@link useUrlState}, shared by URL param KEY.
 *
 * A URL write reaches `useSearchParams()` a render after it is made: Next.js
 * applies a `window.history` write inside a transition (and a router write,
 * before `useUrlState` used `window.history`, only after a server round trip).
 * `useUrlState` hides that by showing the written value immediately. That layer
 * used to be local `useState` per hook INSTANCE, so it only hid the wait from
 * the component that wrote — every other component reading the same param kept
 * the old value until the write landed. Two components reading `?filters=` (the
 * Explorer and the detail panel applying a filter into it) disagreed for that
 * whole window, and the Explorer looked slow to react to the panel.
 *
 * So the pending value lives here, keyed by param, and every mounted instance
 * reads the same one. Kept free of React (plain subscribe/read/write), so
 * `useSyncExternalStore` can sit on top and the rules are unit-testable in the
 * node vitest project.
 *
 * An entry is dropped — the URL becomes the source of truth again — when:
 * - the URL now holds the written value (the write landed);
 * - the pathname differs from the one it was written on (the reader left the
 *   page the write was aimed at, so it can never land there);
 * - the last instance reading the key unmounts (nothing is left to show it,
 *   and a value surviving that would greet the next page as a stale "pending").
 */

/** "No pending value" — a Symbol, because `null` is a legitimate param value. */
export const UNSET = Symbol('useUrlState/unset');
export type Unset = typeof UNSET;

interface PendingWrite {
  value: unknown;
  pathname: string;
}

const pending = new Map<string, PendingWrite>();
const readers = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeOptimistic(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The pending value for `key`, or {@link UNSET}. Returns the stored reference
 * itself, so repeated reads are `===` — what `useSyncExternalStore` requires of
 * a snapshot.
 */
export function readOptimistic(key: string): unknown {
  const entry = pending.get(key);
  return entry ? entry.value : UNSET;
}

export function writeOptimistic(key: string, value: unknown, pathname: string): void {
  pending.set(key, { value, pathname });
  notify();
}

/** Drop the pending value for `key` if the URL has caught up with it, or can no longer. */
export function settleOptimistic(
  key: string,
  { pathname, urlMatches }: { pathname: string; urlMatches: boolean },
): void {
  const entry = pending.get(key);
  if (!entry) return;
  if (!urlMatches && entry.pathname === pathname) return;
  pending.delete(key);
  notify();
}

/** Count a mounted reader of `key`; the returned release drops its pending value with the last one. */
export function retainOptimistic(key: string): () => void {
  readers.set(key, (readers.get(key) ?? 0) + 1);
  return () => {
    const left = (readers.get(key) ?? 1) - 1;
    if (left > 0) {
      readers.set(key, left);
      return;
    }
    readers.delete(key);
    if (pending.delete(key)) notify();
  };
}

/** Test seam: forget every pending value and reader. */
export function resetOptimisticForTests(): void {
  pending.clear();
  readers.clear();
}
