'use client';

import { useQuery } from '@tanstack/react-query';
import { getPlanUsage } from '@/lib/plan';

/**
 * The caller's total memory count — the SAME figure the /settings/plan page
 * shows, because both read the shared `lorekit_memory_count` RPC (personal
 * active + org-owned active across the caller's orgs). NOT a paginated list
 * length: the header badge used to count `useLoreData().lessons`, which is only
 * the first page (capped at the API's 100-row maximum), so it stuck at
 * "100 memories" for any larger account.
 *
 * Caveat: `lorekit_memory_count` has no `expires_at` filter, so it can over-count
 * TTL-expired rows relative to the expiry-aware `lorekit_memory_scopes` /
 * `lorekit_memory_activity` views the Explorer and heatmap use.
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
