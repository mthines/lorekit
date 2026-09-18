'use client';

/**
 * PendingInvitesBanner — a dismissible `/lore` banner surfacing invites
 * addressed to the current user. Passive, one invite shown at a time (not a
 * modal interrupt — ux-design core-principles). Accepting routes to the
 * Explorer filtered to the new org with a one-time toast; declining/dismissing
 * just clears the banner. SSR-seeded via `initialInvites` so the first paint
 * has no loading flash; feeds the shared `['pending-invites']` query key that
 * also drives the Organization nav badge (plan.md Decision D6).
 */

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Mail, X } from 'lucide-react';
import { type OrgInvite } from '@/lib/org-invites';
import { usePendingInvitesForMe } from '@/lib/queries/pending-invites';
import { useDismissedInviteIds } from '@/lib/hooks/useDismissedInviteIds';
import { useInviteActions } from '@/lib/hooks/useInviteActions';
import { visibleInvites } from '@/lib/org-ui';
import { InviteDetailsDialog } from '@/components/dashboard/InviteDetailsDialog';
import { Button, IconButton } from '@/components/ui/Button';

interface PendingInvitesBannerProps {
  initialInvites: OrgInvite[];
}

export function PendingInvitesBanner({ initialInvites }: PendingInvitesBannerProps) {
  const reduceMotion = useReducedMotion();
  const { data: invites = initialInvites } = usePendingInvitesForMe(initialInvites);
  const [dismissedIds, dismiss, hasHydrated] = useDismissedInviteIds();
  const [viewingInvite, setViewingInvite] = useState<OrgInvite | null>(null);
  // The single accept/decline path, shared with the settings list and
  // InviteDetailsDialog (AC-7) — closing the dialog on settle so a resolved
  // invite never lingers under it.
  const { pending, accept, decline } = useInviteActions({
    onSettled: () => setViewingInvite(null),
  });

  const shown = visibleInvites(invites, dismissedIds);
  // Gate on hasHydrated: nothing invite-related renders on the server or first
  // client paint, so a banner this browser already dismissed never flashes.
  const invite = hasHydrated ? shown[0] : undefined;

  return (
    <AnimatePresence>
      {invite && (
        <motion.div
          key={invite.id}
          role="region"
          aria-label={`Invitation to join ${invite.org?.name ?? 'an organization'}`}
          initial={{ opacity: 0, y: reduceMotion ? 0 : -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden rounded-xl border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)]"
        >
          <div className="flex items-start gap-3 p-4">
            <Mail className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--color-content-primary)]">
                Someone invited you to{' '}
                <span className="font-medium">{invite.org?.name ?? 'an organization'}</span>.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  analyticsId="invite.accept"
                  onClick={() => accept(invite)}
                  disabled={pending}
                >
                  Accept
                </Button>
                <Button
                  variant="outline"
                  analyticsId="invite.decline"
                  onClick={() => decline(invite)}
                  disabled={pending}
                >
                  Decline
                </Button>
                <Button
                  variant="ghost"
                  analyticsId="invite.view-details"
                  onClick={() => setViewingInvite(invite)}
                >
                  View details
                </Button>
              </div>
            </div>
            <IconButton
              variant="ghost"
              analyticsId="invite.dismiss-banner"
              onClick={() => dismiss(invite.id)}
              label="Dismiss invitation banner"
              icon={<X className="size-4" aria-hidden />}
            />
          </div>
        </motion.div>
      )}
      <InviteDetailsDialog
        invite={viewingInvite}
        pending={pending}
        onClose={() => setViewingInvite(null)}
        onAccept={accept}
        onDecline={decline}
      />
    </AnimatePresence>
  );
}
