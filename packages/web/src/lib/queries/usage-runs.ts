'use client';

/**
 * Data fetch behind the Settings → Runs page
 * (`components/settings/RunsList.tsx`).
 *
 * A thin wrapper over `GET /memories/usage/runs`, plus a second query
 * (`useRunUsage`) for the per-run drill-down — the SAME `GET /memories/usage`
 * every other usage view calls, just filtered to one `correlation_id`. That
 * reuse is the point: a run's detail is not a new endpoint, it's the existing
 * one with the filter this page exists to make discoverable.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { usageRunsRequest, usageRequest } from '@/lib/api/memories';
import type { UsageRunsResponse, UsageStatsResponse } from '@lorekit/schemas/usage';

const EMPTY_RUNS: UsageRunsResponse = { range: { since: '', until: '' }, runs: [], next_cursor: null };

async function fetchRuns(cursor: string | null, signal?: AbortSignal): Promise<UsageRunsResponse> {
  const token = await browserAccessToken();
  if (!token) return EMPTY_RUNS;
  return usageRunsRequest(token, { limit: 20, ...(cursor ? { cursor } : {}) }, signal);
}

export function useUsageRuns(cursor: string | null) {
  return useQuery<UsageRunsResponse>({
    queryKey: ['usage-runs', cursor],
    queryFn: ({ signal }) => fetchRuns(cursor, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

async function fetchRunUsage(correlationId: string, signal?: AbortSignal): Promise<UsageStatsResponse | null> {
  const token = await browserAccessToken();
  if (!token) return null;
  return usageRequest(token, { correlation_id: correlationId }, signal);
}

/** The drill-down: `GET /memories/usage?correlation_id=<id>`, on demand (row expand). */
export function useRunUsage(correlationId: string | null) {
  return useQuery<UsageStatsResponse | null>({
    queryKey: ['run-usage', correlationId],
    queryFn: ({ signal }) => (correlationId ? fetchRunUsage(correlationId, signal) : Promise.resolve(null)),
    enabled: correlationId !== null,
    staleTime: 60_000,
  });
}
