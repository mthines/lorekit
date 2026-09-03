'use client';

/**
 * Insights' usage-derived sections — the `HealthSummary` verdict banner,
 * `UsageHealth`'s friction/latency/coverage diagnostics, and `AgentBreakdown`'s
 * "who is reading" — share ONE range control and ONE fetch, so switching the
 * range moves all three together instead of leaving them describing three
 * different periods.
 *
 * Distinct from `useDashboardData` (the Overview's FIXED 62-day window,
 * re-bucketed client-side so its range picker never refetches): this fetches
 * the EXACT selected window from `GET /memories/usage`, plus the immediately
 * preceding window of the same length, so a `TrendChip` can answer "is my
 * agent's call volume up this week vs. last" without a second aggregation
 * path. Two requests instead of one wide fetch because `/usage` returns a flat
 * aggregate (no per-bucket breakdown to re-slice client-side, unlike
 * `/activity`/`/read-activity`) — the endpoint already accepts explicit
 * `since`/`until` (the Explorer's stats header uses the identical shape), so
 * this needs no new API surface.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { usageRequest } from '@/lib/api/memories';
import type { UsageStatRow, UsageSummary } from '@lorekit/schemas/usage';
import { resolveRange, type AbsoluteRange, type TimeRange } from '@/lib/time-range';

export interface InsightsUsageWindow {
  rows: UsageStatRow[];
  summary: UsageSummary;
}

export interface InsightsUsageData {
  current: InsightsUsageWindow;
  previous: InsightsUsageWindow;
}

const EMPTY_SUMMARY: UsageSummary = {
  total_events: 0,
  reads: 0,
  writes: 0,
  other: 0,
  records_read: 0,
  archived: 0,
  expired: 0,
  by_outcome: {},
};
const EMPTY_WINDOW: InsightsUsageWindow = { rows: [], summary: EMPTY_SUMMARY };
const EMPTY: InsightsUsageData = { current: EMPTY_WINDOW, previous: EMPTY_WINDOW };

/**
 * The window immediately BEFORE `window`, same span — "last week" for a
 * "this week" selection. Half-open like every other range here: the previous
 * window's `to` is exactly the current window's `from`, so the two tile with
 * no gap and no overlap (and therefore no double-counted instant either way).
 */
export function priorWindow(window: AbsoluteRange): AbsoluteRange {
  const span = Date.parse(window.to) - Date.parse(window.from);
  return { from: new Date(Date.parse(window.from) - span).toISOString(), to: window.from };
}

async function fetchInsightsUsage(
  current: AbsoluteRange,
  previous: AbsoluteRange,
  signal?: AbortSignal,
): Promise<InsightsUsageData> {
  const token = await browserAccessToken();
  if (!token) return EMPTY;

  const [currentRes, previousRes] = await Promise.all([
    usageRequest(token, { since: current.from, until: current.to }, signal),
    usageRequest(token, { since: previous.from, until: previous.to }, signal),
  ]);

  return {
    current: { rows: currentRes.by_tool, summary: currentRes.summary },
    previous: { rows: previousRes.by_tool, summary: previousRes.summary },
  };
}

/**
 * `range` is expected to resolve to a BOUNDED window — the callers restrict
 * their `RangePicker` presets to `24h`/`7d`/`30d`/`90d` (no `all`) so this
 * never has to invent a substitute the way `effectiveStatsRange` does for the
 * Explorer: an unbounded "previous period" has no natural length, and a
 * trend comparison needs one. A malformed selection still fails open to `7d`
 * rather than crashing, matching this module's other range consumers.
 */
export function useInsightsUsage(range: TimeRange, nowIso: string) {
  // Falls open to a zero-length window (never `!`) if even `nowIso` itself
  // fails to parse — a degenerate empty result rather than a thrown error.
  const window = resolveRange(range, nowIso) ?? resolveRange({ preset: '7d' }, nowIso) ?? { from: nowIso, to: nowIso };
  const previous = priorWindow(window);

  return useQuery<InsightsUsageData>({
    queryKey: ['insights-usage', window.from, window.to],
    queryFn: ({ signal }) => fetchInsightsUsage(window, previous, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
