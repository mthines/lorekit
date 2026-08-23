'use client';

/**
 * Data fetch behind {@link ScopeConsumption} (`components/lore/ScopeConsumption.tsx`).
 *
 * A second, independent call to `GET /memories/read-activity` — not a reuse of
 * `useExplorerStats`'s — because that hook narrows to `?scope=` when one is
 * selected (`readActivityRequest(token, { ..., scope })`), and a leaderboard
 * needs the UNFILTERED per-scope breakdown regardless of the page's current
 * scope selection: ranking "what does the account read" is a different
 * question than "how much did the selected scope get read". The bucket unit is
 * irrelevant here (the pure ranker sums across all of them), so it always asks
 * for `day` buckets rather than following the caller's chart granularity.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { readActivityRequest } from '@/lib/api/memories';
import { rankScopeConsumption, type ScopeConsumption } from '@/lib/scope-consumption';

const EMPTY: ScopeConsumption = { rows: [], total: 0 };

async function fetchScopeConsumption(since: string, until: string, signal?: AbortSignal): Promise<ScopeConsumption> {
  const token = await browserAccessToken();
  if (!token) return EMPTY;
  const response = await readActivityRequest(token, { bucket: 'day', since, until }, signal);
  return rankScopeConsumption(response.buckets);
}

export function useScopeConsumption(since: string, until: string) {
  return useQuery<ScopeConsumption>({
    queryKey: ['scope-consumption', since, until],
    queryFn: ({ signal }) => fetchScopeConsumption(since, until, signal),
    placeholderData: keepPreviousData,
    // Matches useExplorerStats — read together, refresh together.
    staleTime: 90_000,
  });
}
