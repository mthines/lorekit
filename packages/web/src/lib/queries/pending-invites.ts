import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { OrgInvite } from '@/lib/org-invites';
import { getAppRoute } from '@/lib/app-route';

/**
 * Shared TanStack query key for pending invites — the ONE cache entry consumed
 * by the `PendingInvitesBanner`, the Organization nav badge (`SettingsNav`),
 * and the accept/decline invalidations. Hoisted so those call sites can never
 * drift out of sync with the fetch (plan.md Decision D6).
 */
export const PENDING_INVITES_QUERY_KEY = ['pending-invites'] as const;

/** The route handler (`app/api/invites/pending/route.ts`) the query reads. */
export const PENDING_INVITES_PATH = '/api/invites/pending';

/**
 * Shared query hook — SSR-seeded via `initialData` so there is exactly ONE
 * cache entry rather than independent fetches per consumer.
 *
 * Read through `GET /api/invites/pending` rather than by calling the server
 * action: Next runs server actions one at a time per client, so this read used
 * to queue with the plan-usage badge and the Explorer's list on every `/lore`
 * load and window focus, and could not be cancelled (see `lib/app-route.ts`).
 * The server-rendered pages still call `listPendingInvitesForMe` directly — on
 * the server it is a plain function call, with no queue.
 */
export function usePendingInvitesForMe(initialData?: OrgInvite[]): UseQueryResult<OrgInvite[]> {
  return useQuery<OrgInvite[]>({
    queryKey: PENDING_INVITES_QUERY_KEY,
    queryFn: ({ signal }) => getAppRoute<OrgInvite[]>(PENDING_INVITES_PATH, signal),
    initialData,
    staleTime: 60_000,
  });
}
