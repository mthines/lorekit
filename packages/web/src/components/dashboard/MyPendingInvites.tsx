'use client';

/**
 * MyPendingInvites — the Organization settings surface for invites addressed to
 * the CURRENT user (distinct from `OrganizationManager`'s per-org list of
 * invites you SENT). Lists every pending invitation with Accept / Decline /
 * View details, so the settings page is the canonical place to act on them —
 * this list deliberately IGNORES the per-browser banner dismissals, because
 * dismissing the `/lore` banner only quiets the interrupt, it does not decline
 * the invite.
 *
 * SSR-seeded via `initialInvites` (no loading flash) and feeds the shared
 * `['pending-invites']` query key, so accepting/declining here updates the
 * `/lore` banner, the header indicator, and the nav badge at once. Renders
 * nothing when there are no pending invites, so the page shows no empty panel.
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Mail } from 'lucide-react';
import { type OrgInvite } from '@/lib/org-invites';
import { usePendingInvitesForMe } from '@/lib/queries/pending-invites';
import { useInviteActions } from '@/lib/hooks/useInviteActions';
import { inviteExpiryLabel } from '@/lib/org-ui';
import { InviteDetailsDialog } from '@/components/dashboard/InviteDetailsDialog';
import { Button } from '@/components/ui/Button';
import { SectionPanel } from '@/components/ui/SectionPanel';

const ROLE_LABEL: Record<OrgInvite['role'], string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

interface MyPendingInvitesProps {
  initialInvites: OrgInvite[];
}

export function MyPendingInvites({ initialInvites }: MyPendingInvitesProps) {
  const { data: invites = initialInvites } = usePendingInvitesForMe(initialInvites);
  const [viewingInvite, setViewingInvite] = useState<OrgInvite | null>(null);
  const { pending, accept, decline } = useInviteActions({
    onSettled: () => setViewingInvite(null),
  });

  const shown = invites.filter((invite) => invite.status === 'pending');
  if (shown.length === 0) return null;

  const now = new Date();

  return (
    <SectionPanel
      icon={<Mail className="size-4.5" />}
      title="Your invitations"
      subtitle="Organizations that have invited you. Accept to start sharing their lore."
    >
      <div className="flex flex-col gap-2">
        <AnimatePresence>
          {shown.map((invite) => {
            const expiry = inviteExpiryLabel(invite.expires_at, now);
            return (
              <motion.div
                key={invite.id}
                layout
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5"
              >
                <Mail className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--color-content-primary)]">
                    <span className="font-medium">{invite.org?.name ?? 'An organization'}</span>
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-content-tertiary)]">
                    <span className="rounded-full bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[var(--color-accent)]">
                      {ROLE_LABEL[invite.role]}
                    </span>
                    {expiry && <span>{expiry}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    analyticsId="invite.accept"
                    onClick={() => accept(invite)}
                    disabled={pending}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    analyticsId="invite.decline"
                    onClick={() => decline(invite)}
                    disabled={pending}
                  >
                    Decline
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    analyticsId="invite.view-details"
                    onClick={() => setViewingInvite(invite)}
                  >
                    View details
                  </Button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <InviteDetailsDialog
        invite={viewingInvite}
        pending={pending}
        onClose={() => setViewingInvite(null)}
        onAccept={accept}
        onDecline={decline}
      />
    </SectionPanel>
  );
}
