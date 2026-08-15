'use client';

/**
 * PendingInvitesBanner — a dismissible Overview banner surfacing invites
 * addressed to the current user. Passive, one invite shown at a time (not a
 * modal interrupt — ux-design core-principles). Accepting routes to the
 * Explorer filtered to the new org with a one-time toast; declining/dismissing
 * just clears the banner. SSR-seeded via `initialInvites` so the first paint
 * has no loading flash; feeds the shared `['pending-invites']` query key that
 * also drives the Organization nav badge (plan.md Decision D6).
 */

import { useState, useTransition } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, X } from 'lucide-react';
import { acceptInvite, declineInvite, type OrgInvite } from '@/lib/org-invites';
import { usePendingInvitesForMe, PENDING_INVITES_QUERY_KEY } from '@/lib/queries/pending-invites';
import { useDismissedInviteIds } from '@/lib/hooks/useDismissedInviteIds';
import { visibleInvites } from '@/lib/org-ui';
import { serialise } from '@/lib/hooks/useUrlState';
import type { Filter } from '@/lib/filters';
import { useToast } from '@/components/providers/ToastProvider';
import { InviteDetailsDialog } from '@/components/dashboard/InviteDetailsDialog';

interface PendingInvitesBannerProps {
  initialInvites: OrgInvite[];
}

export function PendingInvitesBanner({ initialInvites }: PendingInvitesBannerProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reduceMotion = useReducedMotion();
  const { data: invites = initialInvites } = usePendingInvitesForMe(initialInvites);
  const [dismissedIds, dismiss, hasHydrated] = useDismissedInviteIds();
  const [pending, startTransition] = useTransition();
  const [viewingInvite, setViewingInvite] = useState<OrgInvite | null>(null);

  const shown = visibleInvites(invites, dismissedIds);
  // Gate on hasHydrated: nothing invite-related renders on the server or first
  // client paint, so a banner this browser already dismissed never flashes.
  const invite = hasHydrated ? shown[0] : undefined;

  // Shared by both the banner's quick actions AND InviteDetailsDialog's
  // Accept/Decline (AC-7) — a single accept/decline path, never a second,
  // divergent one wired to the modal.
  function handleAccept(target: OrgInvite) {
    startTransition(async () => {
      const result = await acceptInvite(target.id);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setViewingInvite(null);
      await queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
      const orgName = target.org?.name ?? 'the organization';
      showToast(`You joined ${orgName}. Their shared lore now appears in your Explorer.`, 'success');
      // Ownership is a server-side filter DIMENSION now (migration 00064), keyed
      // by the org SLUG. Deep-link straight into the Explorer's `?filters=` bar
      // with an owner filter, so the freshly-joined org is pre-selected. The
      // legacy `?owner=` param is gone: the Explorer still READS it for old
      // links, but writing a slug-keyed filter here lands exactly, where the old
      // uuid form could not be resolved to a slug on arrival.
      const slug = target.org?.slug;
      if (slug) {
        const ownerFilter: Filter[] = [{ field: 'owner', operator: 'in', values: [slug] }];
        router.push(`/lore?filters=${encodeURIComponent(serialise(ownerFilter))}`);
      } else {
        router.push('/lore');
      }
    });
  }

  function handleDecline(target: OrgInvite) {
    startTransition(async () => {
      const result = await declineInvite(target.id);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setViewingInvite(null);
      await queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
    });
  }

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
                <button
                  type="button"
                  onClick={() => handleAccept(invite)}
                  disabled={pending}
                  className="flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => handleDecline(invite)}
                  disabled={pending}
                  className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-border)] px-4 text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => setViewingInvite(invite)}
                  className="flex min-h-11 items-center justify-center rounded-lg px-3 text-sm text-[var(--color-content-secondary)] underline-offset-2 transition-colors duration-150 hover:text-[var(--color-content-primary)] hover:underline"
                >
                  View details
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(invite.id)}
              aria-label="Dismiss invitation banner"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </motion.div>
      )}
      <InviteDetailsDialog
        invite={viewingInvite}
        pending={pending}
        onClose={() => setViewingInvite(null)}
        onAccept={handleAccept}
        onDecline={handleDecline}
      />
    </AnimatePresence>
  );
}
