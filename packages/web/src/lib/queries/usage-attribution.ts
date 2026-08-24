'use client';

/**
 * Data fetch behind {@link UsageAttribution} (`components/lore/UsageAttribution.tsx`).
 *
 * A dedicated `GET /memories/usage` call rather than reusing
 * `useExplorerStats`'s: that hook discards `by_tool` (it only reads
 * `summary.archived`/`.expired`), and widening its return shape would ripple
 * through every consumer of `ExplorerStatsData`.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { usageRequest } from '@/lib/api/memories';
import type { UsageStatRow } from '@lorekit/schemas/usage';

async function fetchUsageByTool(since: string, until: string, signal?: AbortSignal): Promise<UsageStatRow[]> {
  const token = await browserAccessToken();
  if (!token) return [];
  const response = await usageRequest(token, { since, until }, signal);
  return response.by_tool;
}

export function useUsageByTool(since: string, until: string) {
  return useQuery<UsageStatRow[]>({
    queryKey: ['usage-by-tool', since, until],
    queryFn: ({ signal }) => fetchUsageByTool(since, until, signal),
    placeholderData: keepPreviousData,
    staleTime: 90_000,
  });
}
