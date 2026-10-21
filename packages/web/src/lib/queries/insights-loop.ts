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
 * `useLoreUtilitySummary()` request the cost line and the utility grid share.
 *
 * ## The row cap is reported, not hidden
 *
 * `currentCapped` / `previousCapped` say whether either series of that window
 * reached PostgREST's row cap (see `isAtRowCap`). The page then says the
 * figures may be incomplete instead of drawing the cliff a truncated series
 * would show at "now", and drops deltas that would compare a partial window.
 *
 * ## The window travels with the data
 *
 * Both hooks keep the previous result on screen while a new range loads
 * (`keepPreviousData`). Each result therefore carries the `window` it was
 * fetched for, and the page draws grids from THAT window — never re-gridding
 * last week's rows onto this month's axis as if the empty days were fact.
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
  /** The window these rows were fetched for. */
  window: AbsoluteRange;
  unit: BucketUnit;
  current: InsightsLoopWindow;
  previous: InsightsLoopWindow;
  /** A current-window series reached the row cap — its newest buckets may be missing. */
  currentCapped: boolean;
  /** A previous-window series reached the row cap — a delta against it is unreliable. */
  previousCapped: boolean;
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

function seriesCapped(w: InsightsLoopWindow): boolean {
  return isAtRowCap(w.writes.length) || isAtRowCap(w.reads.length);
}

async function fetchInsightsLoop(window: AbsoluteRange, signal?: AbortSignal): Promise<InsightsLoopData> {
  const unit = bucketPlanFor(window).unit;
  const token = await browserAccessToken();
  if (!token) {
    return { window, unit, current: EMPTY_WINDOW, previous: EMPTY_WINDOW, currentCapped: false, previousCapped: false };
  }
  const [current, previous] = await Promise.all([
    fetchWindow(token, window, unit, signal),
    fetchWindow(token, priorWindow(window), unit, signal),
  ]);
  return { window, unit, current, previous, currentCapped: seriesCapped(current), previousCapped: seriesCapped(previous) };
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
  /** The window these runs were fetched for. */
  window: AbsoluteRange;
  /** Most recent first — the route orders by `last_seen desc`. */
  runs: UsageRun[];
  /** More runs exist past {@link MAX_RUN_PAGES}; the OLDEST part of the window is missing. */
  truncated: boolean;
}

async function fetchWindowRuns(window: AbsoluteRange, signal?: AbortSignal): Promise<WindowRuns> {
  const token = await browserAccessToken();
  if (!token) return { window, runs: [], truncated: false };
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
    if (!cursor) return { window, runs, truncated: false };
  }
  return { window, runs, truncated: true };
}

export function useWindowRuns(window: AbsoluteRange) {
  return useQuery<WindowRuns>({
    queryKey: ['insights-window-runs', window.from, window.to],
    queryFn: ({ signal }) => fetchWindowRuns(window, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
