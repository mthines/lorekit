'use client';

/**
 * useInviteActions — the ONE accept/decline path for a pending org invite,
 * shared by every surface that offers those actions: the `/lore`
 * `PendingInvitesBanner`, the header `PendingInvitesIndicator`'s destination,
 * the settings `MyPendingInvites` list, and `InviteDetailsDialog` (which every
 * caller passes these callbacks down to). Extracted so there is never a second,
 * divergent accept path — accepting from any surface routes to the Explorer
 * filtered to the new org and shows the same success toast.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { acceptInvite, declineInvite, type OrgInvite } from '@/lib/org-invites';
import { PENDING_INVITES_QUERY_KEY } from '@/lib/queries/pending-invites';
import { serialise } from '@/lib/hooks/useUrlState';
import type { Filter } from '@/lib/filters';
import { showToast } from '@/lib/toast';

export interface InviteActions {
  /** True while an accept/decline request is in flight (disables both actions). */
  pending: boolean;
  accept: (invite: OrgInvite) => void;
  decline: (invite: OrgInvite) => void;
}

export interface UseInviteActionsOptions {
  /**
   * Run after a successful accept OR decline, before the query invalidation —
   * used by callers that hold their own dialog state (e.g. closing
   * `InviteDetailsDialog`) so the modal doesn't linger over a resolved invite.
   */
  onSettled?: () => void;
}

export function useInviteActions(options?: UseInviteActionsOptions): InviteActions {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();

  function accept(target: OrgInvite) {
    startTransition(async () => {
      const result = await acceptInvite(target.id);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      options?.onSettled?.();
      await queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
      const orgName = target.org?.name ?? 'the organization';
      showToast(`You joined ${orgName}. Their shared lore now appears in your Explorer.`, 'success');
      // Ownership is a server-side filter DIMENSION (migration 00064), keyed by
      // the org SLUG. Deep-link straight into the Explorer's `?filters=` bar with
      // an owner filter so the freshly-joined org is pre-selected.
      const slug = target.org?.slug;
      if (slug) {
        const ownerFilter: Filter[] = [{ field: 'owner', operator: 'in', values: [slug] }];
        router.push(`/lore?filters=${encodeURIComponent(serialise(ownerFilter))}`);
      } else {
        router.push('/lore');
      }
    });
  }

  function decline(target: OrgInvite) {
    startTransition(async () => {
      const result = await declineInvite(target.id);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      options?.onSettled?.();
      await queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
    });
  }

  return { pending, accept, decline };
}
