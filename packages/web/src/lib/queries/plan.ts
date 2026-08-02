'use client';

import { useQuery } from '@tanstack/react-query';
import { getPlanUsage } from '@/lib/plan';

/**
 * The caller's total memory count — the SAME figure the /settings/plan page
 * shows, so the two never disagree. It comes from `lorekit_memory_count`
 * (personal active + org-owned active across the caller's orgs), NOT from a
 * paginated list length: the header badge used to count `useLoreData().lessons`,
 * which is only the first page (capped at the API's 100-row maximum), so it
 * stuck at "100 memories" for any larger account.
 *
 * `getPlanUsage` returns count + limit + plan in one round-trip; the badge needs
 * only the count. Degrades to 0 when there is no session / the RPC fails, matching
 * the plan page's graceful-null handling.
 */
export function useMemoryTotal() {
  return useQuery<number>({
    queryKey: ['memory-total'],
    queryFn: async () => (await getPlanUsage())?.count ?? 0,
    // Changes only when an agent writes — align with the other read-heavy hooks.
    staleTime: 60_000,
  });
}
