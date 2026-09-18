'use client';

/**
 * PendingInvitesIndicator — the always-visible header cue that the current user
 * has org invitations waiting. A Mail icon with a count pill, linking to the
 * Organization settings page where the invites can be accepted or declined.
 *
 * Reads the SAME shared `['pending-invites']` query as the `/lore` banner and
 * the settings nav badge, and respects the same per-browser dismissals via
 * `pendingInviteCount` — so this header badge and the Organization nav badge
 * always agree. Renders nothing until the localStorage-backed dismissals have
 * hydrated (so a dismissed invite never flashes here) and nothing when the
 * count is zero.
 */

import Link from 'next/link';
import { Mail } from 'lucide-react';
import { usePendingInvitesForMe } from '@/lib/queries/pending-invites';
import { useDismissedInviteIds } from '@/lib/hooks/useDismissedInviteIds';
import { pendingInviteCount } from '@/lib/org-ui';
import { Tooltip } from '@/components/ui/Tooltip';

export function PendingInvitesIndicator() {
  const { data: invites = [] } = usePendingInvitesForMe();
  const [dismissedIds, , hasHydrated] = useDismissedInviteIds();
  // 0 until hydrated so the server render and first client paint agree (nothing
  // shown), then the real count once localStorage-backed dismissals are known.
  const count = hasHydrated ? pendingInviteCount(invites, dismissedIds) : 0;
  if (count === 0) return null;

  const label = `${count} pending invitation${count === 1 ? '' : 's'}`;

  return (
    <Tooltip content={label}>
      <Link
        href="/settings/organization"
        aria-label={label}
        className="relative flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <Mail className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
        {/* Count pill — mirrors the Organization nav badge (SectionNav). */}
        <span
          className="absolute -right-1 -top-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-semibold text-[#000]"
          aria-hidden
        >
          {count}
        </span>
      </Link>
    </Tooltip>
  );
}
