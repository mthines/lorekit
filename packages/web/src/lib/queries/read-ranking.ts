'use client';

/**
 * Data fetch behind {@link HotColdLore} (`components/lore/HotColdLore.tsx`).
 *
 * A thin wrapper over `GET /memories/read-ranking` — no client-side
 * aggregation needed, the RPC already returns the ranked, bounded page.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { readRankingRequest } from '@/lib/api/memories';
import type { ReadRankingResponse, ReadRankingDirection } from '@lorekit/schemas/memory';

const EMPTY: ReadRankingResponse = { direction: 'hot', counting_since: new Date(0).toISOString(), entries: [] };

async function fetchReadRanking(
  direction: ReadRankingDirection,
  limit: number,
  signal?: AbortSignal,
): Promise<ReadRankingResponse> {
  const token = await browserAccessToken();
  if (!token) return { ...EMPTY, direction };
  return readRankingRequest(token, { direction, limit }, signal);
}

export function useReadRanking(direction: ReadRankingDirection, limit = 20) {
  return useQuery<ReadRankingResponse>({
    queryKey: ['read-ranking', direction, limit],
    queryFn: ({ signal }) => fetchReadRanking(direction, limit, signal),
    placeholderData: keepPreviousData,
    staleTime: 90_000,
  });
}
