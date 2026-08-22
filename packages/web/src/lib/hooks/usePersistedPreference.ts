'use client';

import { useCallback, useSyncExternalStore } from 'react';

import { UNRESOLVED } from '@/lib/persisted-preference';

/**
 * `localStorage` as a React external store — the effectful half of
 * `lib/persisted-preference.ts`.
 *
 * ## Why `useSyncExternalStore` and not a mount effect
 *
 * The established alternative in this package is `useDismissedInviteIds`: state
 * seeded with the default, `localStorage` read in a `useEffect`, and a
 * `hasHydrated` flag consumers gate on. That is correct — it never reads storage
 * during render, so it cannot mismatch — but it always renders the DEFAULT first
 * and corrects on the next tick. For a list of dismissed ids that is invisible.
 * For a panel's disclosure state it is the flash the feature exists to remove:
 * "expanded, then snap shut" is worse than not remembering at all.
 *
 * `useSyncExternalStore` reads the store on the FIRST render of a client-mounted
 * component (`getSnapshot`), and falls back to a server snapshot only where there
 * is no client (`getServerSnapshot`) — the same shape `useMediaQuery` uses in this
 * directory, for the same reason. It also subscribes, so two tabs agree: a
 * `storage` event in one is a re-render in the other, for free.
 *
 * ## The three states, and why `''` is not `null`
 *
 * - `null` ({@link UNRESOLVED}) — produced ONLY by `getServerSnapshot`. "We have
 *   not consulted a store." Callers must render their neutral state here, not
 *   their default, or they reintroduce the flash.
 * - `''` — "consulted; nothing stored" (or storage threw). Callers fall back to
 *   the product default.
 * - anything else — the stored value.
 *
 * Collapsing the first two is the bug this split exists to prevent.
 *
 * ## Failure is always silent
 *
 * `localStorage` throws outright in some private-browsing modes and whenever the
 * user has blocked site data — on the getter, not just the setter. Every access
 * here is wrapped, and a failure degrades to "this preference does not persist",
 * never to a thrown render.
 */

interface Entry {
  subscribers: Set<() => void>;
  /** The last value handed out, so `getSnapshot` is referentially stable. */
  snapshot: string;
}

/**
 * One entry per key, shared by every consumer of that key.
 *
 * Two components reading the same preference must see the same value and must
 * cost one listener, not two — and a write in either must re-render both.
 */
const registry = new Map<string, Entry>();

/** One `storage` listener for the whole module, fanned out per key. */
let storageListenerAttached = false;

function readRaw(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    // Blocked site data / private mode: behave exactly like "nothing stored".
    return '';
  }
}

function getOrCreateEntry(key: string): Entry {
  let entry = registry.get(key);
  if (!entry) {
    entry = { subscribers: new Set(), snapshot: readRaw(key) };
    registry.set(key, entry);
  }
  return entry;
}

/**
 * Re-read `key` and notify its subscribers if it actually changed.
 *
 * The equality check is what keeps `getSnapshot` stable: React calls it more than
 * once per render and treats a new value as a change, so handing back a freshly
 * read — but identical — string on every call would be harmless for strings yet
 * a needless re-render on every notify. Comparing first makes a no-op write free.
 */
function refresh(key: string): void {
  const entry = registry.get(key);
  if (!entry) return;
  const next = readRaw(key);
  if (next === entry.snapshot) return;
  entry.snapshot = next;
  entry.subscribers.forEach((notify) => notify());
}

/**
 * Cross-tab agreement. The `storage` event fires in every OTHER tab on the
 * origin, so a viewer who collapses the panel in one tab finds it collapsed in
 * the next. `event.key === null` is the `localStorage.clear()` case, which
 * invalidates everything.
 */
function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    for (const key of registry.keys()) refresh(key);
    return;
  }
  if (registry.has(event.key)) refresh(event.key);
}

function subscribe(key: string, onStoreChange: () => void): () => void {
  const entry = getOrCreateEntry(key);
  entry.subscribers.add(onStoreChange);

  if (!storageListenerAttached) {
    window.addEventListener('storage', onStorage);
    storageListenerAttached = true;
  }

  return () => {
    entry.subscribers.delete(onStoreChange);
    if (entry.subscribers.size > 0) return;
    // Drop the entry once nothing is watching this key: the next mount re-reads
    // the store, which is cheap and cannot serve a snapshot that went stale
    // while nobody was listening. The shared `storage` listener goes with the
    // last entry.
    registry.delete(key);
    if (registry.size === 0 && storageListenerAttached) {
      window.removeEventListener('storage', onStorage);
      storageListenerAttached = false;
    }
  };
}

/**
 * Write `value` under `key` and re-render every consumer of that key.
 *
 * Exported as a plain function, not only through the hook, so a non-React caller
 * (a hook's cleanup, an imperative handler) can persist a preference through the
 * same path — there must be exactly one writer, or the in-memory snapshot and the
 * store diverge.
 */
export function writePersistedPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted. The optimistic in-memory update below still applies, so the
    // choice holds for this session and simply does not survive a reload.
  }
  // Only touch the registry when something is actually watching this key —
  // creating an entry for an unwatched key would leave a row (and so keep the
  // shared `storage` listener alive) with no subscriber to serve.
  const entry = registry.get(key);
  if (!entry || entry.snapshot === value) return;
  entry.snapshot = value;
  entry.subscribers.forEach((notify) => notify());
}

export interface PersistedPreference {
  /**
   * The stored string, `''` when nothing is stored, or {@link UNRESOLVED}
   * (`null`) when no client store has been consulted yet — see the module
   * docblock for why those last two are different facts.
   */
  raw: string | null;
  /** Persist a new value and re-render every consumer of this key. */
  write: (value: string) => void;
}

/** Subscribe to one `localStorage` key. Pair with the codecs in `lib/persisted-preference.ts`. */
export function usePersistedPreference(key: string): PersistedPreference {
  const raw = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => subscribe(key, onStoreChange), [key]),
    // Client snapshot: the cached value if something is already subscribed to this
    // key, otherwise a direct read. Both are plain strings, so referential
    // stability across repeat calls is automatic.
    useCallback(() => registry.get(key)?.snapshot ?? readRaw(key), [key]),
    // Server snapshot: the ONLY producer of `null`. Nothing here touches
    // `window`, which is what makes the hook safe in a server render.
    useCallback(() => UNRESOLVED, []),
  );

  const write = useCallback((value: string) => writePersistedPreference(key, value), [key]);

  return { raw, write };
}
