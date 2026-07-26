import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { listPendingInvitesForMe, type OrgInvite } from '@/lib/org-invites';

/**
 * Shared TanStack query key for pending invites — the ONE cache entry consumed
 * by the `PendingInvitesBanner`, the Organization nav badge (`SettingsNav`),
 * and the accept/decline invalidations. Hoisted so those call sites can never
 * drift out of sync with the fetch (plan.md Decision D6).
 */
export const PENDING_INVITES_QUERY_KEY = ['pending-invites'] as const;

/**
 * Shared query hook — SSR-seeded via `initialData` so there is exactly ONE
 * cache entry rather than independent fetches per consumer.
 */
export function usePendingInvitesForMe(initialData?: OrgInvite[]): UseQueryResult<OrgInvite[]> {
  return useQuery<OrgInvite[]>({
    queryKey: PENDING_INVITES_QUERY_KEY,
    queryFn: () => listPendingInvitesForMe(),
    initialData,
    staleTime: 60_000,
  });
}
