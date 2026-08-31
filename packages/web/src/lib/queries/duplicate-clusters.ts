'use client';

/**
 * Data fetch behind {@link DuplicateClusters} (`components/lore/DuplicateClusters.tsx`).
 *
 * A thin wrapper over `GET /memories/clusters` — the server does the clustering,
 * the ranking and the recurrence-class join, so there is nothing to aggregate
 * here. (Doing it browser-side is not an option this package has: the clustering
 * needs a POPULATION, and a `select … limit N` plus a client-side sweep is the
 * row-cap trap `packages/web/CLAUDE.md` forbids.)
 *
 * **`enabled` is the panel's disclosure.** The panel opens collapsed, so passing
 * `enabled: false` while it is folded is what keeps a quadratic-in-the-worst-case
 * server read off every `/lore` page view. Nothing fetches until a reader asks.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { clustersRequest } from '@/lib/api/memories';
import { browserAccessToken } from '@/lib/api/session-browser';
import type { ClustersResponse } from '@lorekit/schemas/memory';

export interface DuplicateClustersParams {
  /** Exact scope to cluster within, or `null` for every scope the viewer can see. */
  scope: string | null;
  /** Jaccard floor. The server bounds this to 0.5–1. */
  threshold?: number;
  /** Summed-`seen_count` floor for a cluster to count as a candidate. */
  minSeenCount?: number;
  limit?: number;
  /** False while the panel is folded — see the docblock. */
  enabled?: boolean;
}

async function fetchClusters(
  params: DuplicateClustersParams,
  signal?: AbortSignal,
): Promise<ClustersResponse> {
  const token = await browserAccessToken();
  // No session: report an EMPTY window rather than throwing. `candidate_limit`
  // must stay positive to satisfy the response contract, and `candidates: 0`
  // keeps `windowSaturated` false — so the panel shows its empty state without
  // also claiming the window was truncated.
  if (!token) {
    return { threshold: params.threshold ?? 0.8, candidates: 0, candidate_limit: 1, clusters: [] };
  }
  return clustersRequest(
    token,
    {
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.threshold === undefined ? {} : { threshold: params.threshold }),
      ...(params.minSeenCount === undefined ? {} : { min_seen_count: params.minSeenCount }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    },
    signal,
  );
}

export function useDuplicateClusters(params: DuplicateClustersParams) {
  const { scope, threshold, minSeenCount, limit, enabled = true } = params;
  return useQuery<ClustersResponse>({
    queryKey: ['duplicate-clusters', scope, threshold, minSeenCount, limit],
    queryFn: ({ signal }) => fetchClusters(params, signal),
    enabled,
    // Keep the previous window's clusters visible while a new scope resolves, so
    // switching scopes does not blank the panel and re-collapse the reader's
    // selection to nothing — the same call every other Explorer query makes.
    placeholderData: keepPreviousData,
    // Longer than the charts' 90s: this is a housekeeping reading over a
    // recency window, and it costs a clustering pass server-side. Nothing about
    // the answer changes minute to minute.
    staleTime: 300_000,
  });
}
