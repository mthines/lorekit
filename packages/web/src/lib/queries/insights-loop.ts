'use client';

/**
 * Data for the visual Insights page (`insights-visual`): the loop strip, the
 * Pulse timeline and the recall flow share ONE fetch over ONE window, and the
 * runs views share a second, paginated one.
 *
 * ## One window, plus the one before it
 *
 * Every windowed figure on the page follows the page's single range control, so
 * the strip, the timeline and the flow can never describe different periods.
 * The immediately preceding window of equal length is fetched beside it
 * (`priorWindow`, shared with `insights-usage.ts`) because a period delta needs
 * the actual previous period, not a slice of a wider one.
 *
 * No new API surface: `/activity`, `/read-activity` and `/usage` all accept
 * explicit `since`/`until`, and the census comes from the same cached
 * `useLoreUtility({})` call the utility grid already makes.
 *
 * ## The row cap is reported, not hidden
 *
 * `capped` is true when either CURRENT series reached PostgREST's row cap (see
 * `isAtRowCap`). The page then says the timeline may be incomplete instead of
 * drawing the cliff a truncated series would show at "now".
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { ActivityBucket, ReadActivityBucket } from '@lorekit/schemas/memory';
import type { UsageRun, UsageStatsResponse } from '@lorekit/schemas/usage';
import { browserAccessToken } from '@/lib/api/session-browser';
import { activityRequest, readActivityRequest, usageRequest, usageRunsRequest } from '@/lib/api/memories';
import { isAtRowCap } from '@/lib/insights-loop';
import { priorWindow } from '@/lib/queries/insights-usage';
import { bucketPlanFor, type AbsoluteRange, type BucketUnit } from '@/lib/time-range';

export interface InsightsLoopWindow {
  writes: ActivityBucket[];
  reads: ReadActivityBucket[];
  usage: UsageStatsResponse;
}

export interface InsightsLoopData {
  unit: BucketUnit;
  current: InsightsLoopWindow;
  previous: InsightsLoopWindow;
  /** Either current series reached the row cap — the timeline may be missing its newest buckets. */
  capped: boolean;
}

async function fetchWindow(
  token: string,
  window: AbsoluteRange,
  unit: BucketUnit,
  signal?: AbortSignal,
): Promise<InsightsLoopWindow> {
  const params = { bucket: unit, since: window.from, until: window.to };
  const [activity, readActivity, usage] = await Promise.all([
    activityRequest(token, params, signal),
    readActivityRequest(token, params, signal),
    usageRequest(token, { since: window.from, until: window.to }, signal),
  ]);
  return { writes: activity.buckets, reads: readActivity.buckets, usage };
}

const EMPTY_USAGE: UsageStatsResponse = {
  range: { since: null, until: null },
  correlation_id: null,
  summary: { total_events: 0, reads: 0, writes: 0, other: 0, records_read: 0, archived: 0, expired: 0, by_outcome: {} },
  by_tool: [],
  by_scope_type: [],
};
const EMPTY_WINDOW: InsightsLoopWindow = { writes: [], reads: [], usage: EMPTY_USAGE };

async function fetchInsightsLoop(window: AbsoluteRange, signal?: AbortSignal): Promise<InsightsLoopData> {
  const unit = bucketPlanFor(window).unit;
  const token = await browserAccessToken();
  if (!token) return { unit, current: EMPTY_WINDOW, previous: EMPTY_WINDOW, capped: false };
  const [current, previous] = await Promise.all([
    fetchWindow(token, window, unit, signal),
    fetchWindow(token, priorWindow(window), unit, signal),
  ]);
  return {
    unit,
    current,
    previous,
    capped: isAtRowCap(current.writes.length) || isAtRowCap(current.reads.length),
  };
}

export function useInsightsLoop(window: AbsoluteRange) {
  return useQuery<InsightsLoopData>({
    queryKey: ['insights-loop', window.from, window.to],
    queryFn: ({ signal }) => fetchInsightsLoop(window, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/**
 * How many pages of runs the page reads before it stops and says so.
 *
 * 5 × 100 = 500 runs — far beyond what a weekday × hour grid needs to show a
 * rhythm, and a bound on what one page view can cost. `truncated` tells the
 * components to caption the cut rather than imply the grid is complete.
 */
export const MAX_RUN_PAGES = 5;
const RUNS_PAGE_SIZE = 100;

export interface WindowRuns {
  runs: UsageRun[];
  truncated: boolean;
}

async function fetchWindowRuns(window: AbsoluteRange, signal?: AbortSignal): Promise<WindowRuns> {
  const token = await browserAccessToken();
  if (!token) return { runs: [], truncated: false };
  const runs: UsageRun[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < MAX_RUN_PAGES; pageIndex++) {
    const runsPage = await usageRunsRequest(
      token,
      { since: window.from, until: window.to, limit: RUNS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      signal,
    );
    runs.push(...runsPage.runs);
    cursor = runsPage.next_cursor;
    if (!cursor) return { runs, truncated: false };
  }
  return { runs, truncated: true };
}

export function useWindowRuns(window: AbsoluteRange) {
  return useQuery<WindowRuns>({
    queryKey: ['insights-window-runs', window.from, window.to],
    queryFn: ({ signal }) => fetchWindowRuns(window, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
