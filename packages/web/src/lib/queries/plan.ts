'use client';

import { useQuery } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { quotaRequest } from '@/lib/api/memories';

/**
 * Every active memory the caller can see — personal plus org-owned — for the
 * TopBar badge. The `total` of `GET /memories/quota`, the same answer the
 * `memory.quota` MCP tool and `lorekit quota` give. NOT a paginated list length:
 * the badge used to count `useLoreData().lessons`, which is only the first page
 * (capped at the API's 100-row maximum), so it stuck at "100 memories" for any
 * larger account.
 *
 * A browser REST request with React Query's signal, never a server action: Next
 * runs server actions one at a time per client, and this badge used to lead the
 * queue that the Explorer's list waited behind on every `/lore` load and window
 * focus (`packages/web/CLAUDE.md` → "A client read is never a server action").
 *
 * Caveat: the count has no `expires_at` filter (it matches what the memory cap
 * enforces), so it can over-count TTL-expired rows relative to the expiry-aware
 * scope counts the Explorer shows. Degrades to 0 with no session.
 */
export function useMemoryTotal() {
  return useQuery<number>({
    queryKey: ['memory-total'],
    queryFn: async ({ signal }) => {
      const token = await browserAccessToken();
      if (!token) return 0;
      return (await quotaRequest(token, signal)).total;
    },
    // Changes only when an agent writes — align with the other read-heavy hooks.
    staleTime: 60_000,
  });
}
