'use client';

import { useQuery } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { quotaRequest } from '@/lib/api/memories';

/**
 * Every active memory the caller can see (personal + org), for the TopBar badge:
 * the `total` of `GET /memories/quota`, read from the browser with the query's
 * signal — never a server action (`packages/web/CLAUDE.md`). 0 with no session.
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
