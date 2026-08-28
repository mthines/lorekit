'use client';

/**
 * The developer-nav reveal toggle — whether `/settings/developer` shows in
 * the Settings nav for an allowlisted developer in PRODUCTION (outside
 * production it always shows; see `SettingsNav.tsx`). Toggled by 5
 * consecutive clicks on the avatar in `UserSettingsPanel.tsx`
 * (`click-gesture.ts`'s pure counting logic); 5 more clicks hides it again —
 * for a screenshot or a demo, so the nav item isn't sitting there by default.
 *
 * ## Why `useSyncExternalStore` with a manual pub/sub, not the simpler
 * `useState` + `useEffect(() => setState(readLocalStorage()), [])` pattern
 * `useDismissedInviteIds.ts` uses
 *
 * That pattern is correct for `useDismissedInviteIds` because its two
 * consumers (`PendingInvitesBanner`, `SettingsNav`) don't need to react to
 * each other's writes on the SAME page render — a dismiss action is followed
 * by a navigation or an unmount, so a stale sibling instance is never
 * actually visible.
 *
 * This toggle's two consumers — `UserSettingsPanel` (writes, on `/settings/user`)
 * and `SettingsNav` (reads, rendered in `settings/layout.tsx` and so mounted
 * on `/settings/user` AT THE SAME TIME) — genuinely are simultaneously
 * mounted on the same page, and the whole point of the gesture is that
 * revealing/hiding the nav item feels instant. A `useState` copy in each
 * component would only re-sync on remount; this store's `notify()` call
 * (inside `toggleDeveloperNavRevealed`) tells every subscribed instance —
 * regardless of where it lives in the tree — to re-render immediately.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'lorekit:developer-nav-revealed';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Used only when `localStorage` throws (private browsing) — keeps the toggle working for this page load, just not across reloads. */
let memoryFallback = false;

function readRevealed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return memoryFallback;
  }
}

/** Always `false` — the server has no localStorage, and a mismatched hydration flash is worse than a one-frame reveal delay. */
function readServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Flip the reveal state. Degrades to an in-memory-only toggle (this page load only) if `localStorage` is unavailable. */
export function toggleDeveloperNavRevealed(): void {
  const next = !readRevealed();
  memoryFallback = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Falls back to `memoryFallback` above — see `readRevealed`.
  }
  notify();
}

/** Whether the developer nav entry should currently be revealed (production allowlist gate is separate — see `SettingsNav.tsx`). */
export function useDeveloperNavRevealed(): boolean {
  return useSyncExternalStore(subscribe, readRevealed, readServerSnapshot);
}
