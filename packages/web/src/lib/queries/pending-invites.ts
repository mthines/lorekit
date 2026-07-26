import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { listPendingInvitesForMe, type OrgInvite } from '@/lib/org-invites';

/**
 * Shared TanStack query key for pending invites — consumed by both the
 * `PendingInvitesBanner` (Overview, SSR-seeded via `initialData`) and the
 * Organization nav badge count (`SettingsNav`), so there is exactly ONE cache
 * entry rather than two independent fetches (plan.md Decision D6).
 */
export function usePendingInvitesForMe(initialData?: OrgInvite[]): UseQueryResult<OrgInvite[]> {
  return useQuery<OrgInvite[]>({
    queryKey: ['pending-invites'],
    queryFn: () => listPendingInvitesForMe(),
    initialData,
    staleTime: 60_000,
  });
}
