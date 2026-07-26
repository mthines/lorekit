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

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'lorekit:dismissed-invite-ids';

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

export function useDismissedInviteIds(): [string[], (id: string) => void] {
  const [ids, setIds] = useState<string[]>(() => readDismissedIds());

  const dismiss = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      writeDismissedIds(next);
      return next;
    });
  }, []);

  return [ids, dismiss];
}
