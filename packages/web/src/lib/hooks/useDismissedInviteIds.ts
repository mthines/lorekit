'use client';

/**
 * Persists dismissed pending-invite ids in localStorage so a user who
 * dismisses the Overview banner doesn't see it reappear on next load.
 * Shared by `PendingInvitesBanner` (dismiss action) and `SettingsNav` (badge
 * count) so both read the same source of truth. This is storage plumbing,
 * not decision logic — the pure predicate it feeds (`visibleInvites` /
 * `pendingInviteCount`) lives in `org-ui.ts` and is unit-tested there
 * (plan.md Decision D5's functional-core / impure-shell split).
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'lorekit:dismissed-invite-ids';

// Cap the persisted list so a long-lived browser can't grow it without bound
// (every dismissed invite id would otherwise accumulate in localStorage
// forever). 200 is far more than any realistic pending-invite backlog; older
// ids fall off the front — a re-surfaced ancient invite is harmless.
const MAX_DISMISSED = 200;

function readDismissedIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeDismissedIds(ids: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage may be unavailable (private browsing) — dismissal just
    // won't persist across reloads; never throw for this non-critical write.
  }
}

/**
 * Returns `[dismissedIds, dismiss, hasHydrated]`. `hasHydrated` is `false` on
 * the server and on the first client paint, flipping to `true` only after the
 * mount effect has read localStorage. Consumers gate all invite UI (banner, nav
 * badge) on `hasHydrated` so the server render and first client render agree
 * (both empty) — no hydration mismatch and no flash of already-dismissed
 * content. The localStorage read must NOT live in the `useState` initializer:
 * that runs during hydration on the client with the real stored value, which
 * would diverge from the server's empty render.
 */
export function useDismissedInviteIds(): [string[], (id: string) => void, boolean] {
  const [ids, setIds] = useState<string[]>([]);
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setIds(readDismissedIds());
    setHasHydrated(true);
  }, []);

  const dismiss = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id].slice(-MAX_DISMISSED);
      writeDismissedIds(next);
      return next;
    });
  }, []);

  return [ids, dismiss, hasHydrated];
}
