import { useQuery } from '@tanstack/react-query';
import { scopeType } from '@/lib/scope';
import { trendRowsFromActivity, type CountBucketRow, type TrendRow } from '@/lib/aggregations';
import type { ScopeHealth } from '@/components/dashboard/ScopeHealthCard';
import { browserAccessToken } from '@/lib/api/session-browser';
import { activityRequest, listScopesRequest, readActivityRequest, usageRequest } from '@/lib/api/memories';
import type { UsageStatRow } from '@lorekit/schemas/usage';

export interface DashboardData {
  scopes: ScopeHealth[];
  /**
   * Raw trend rows (scope + created_at), one per memory in the trend window.
   * The stat cards compute their range trends from these client-side, so
   * switching the range (24h / 7d / 30d) never triggers a refetch.
   */
  rows: TrendRow[];
  /**
   * Records read per UTC hour over the trend window, from
   * `GET /memories/read-activity` — the "Memories read" card's series.
   *
   * Kept as buckets rather than expanded into rows: read counts run to tens of
   * thousands of records, and the card only ever sums them (`computeCountTrend`).
   */
  readBuckets: CountBucketRow[];
  /**
   * `GET /memories/usage`'s grouped rows, over the SAME trend window as
   * everything above — feeds `UsageHealth`'s friction/latency/coverage-gap
   * diagnostics (pure functions in `lib/usage-health.ts`). The Explorer already
   * calls `usageRequest`; the Overview did not until now.
   */
  usageByTool: UsageStatRow[];
}

/**
 * How far back the stat cards can look: the widest range (30d) is charted
 * against the 30 days before it, so 60 days is the true requirement — plus two
 * days of slack so a bucket on the boundary is never half-populated.
 */
const TREND_WINDOW_DAYS = 62;
const DAY_MS = 86_400_000;

/**
 * Both halves of the Overview come from LoreKit's REST API, aggregated in
 * Postgres.
 *
 * This replaced a single `select scope, created_at … limit 1000` that was wrong
 * in three ways at once: past the cap it dropped scopes entirely, the surviving
 * scopes' totals were understated (the cap is applied to a `created_at desc`
 * ordering, so the oldest rows of every scope fall off), and it shipped up to
 * 1000 rows to the browser to render about sixty numbers.
 *
 * - `GET /memories/scopes` answers the Scope Health cards exactly: one row per
 *   scope with its active count and `last_activity`, at any volume.
 * - `GET /memories/activity` answers the sparkbars: memories per UTC HOUR per
 *   scope over the trend window. Hour granularity because the 24h card buckets
 *   hourly; the payload is sparse (only buckets with activity come back), so it
 *   is bounded by distinct active hours rather than by memory count.
 * - `GET /memories/read-activity` answers the "Memories read" card: records
 *   read per UTC HOUR over the same window, aggregated over `usage_events` in
 *   Postgres for the same reason and with the same sparseness.
 *
 * All three are fetched once, over the widest window any range needs, so
 * switching the shared range picker re-buckets in the browser instead of
 * refetching.
 */
async function fetchDashboardData(signal?: AbortSignal): Promise<DashboardData> {
  const token = await browserAccessToken();
  if (!token) return { scopes: [], rows: [], readBuckets: [], usageByTool: [] };

  const since = new Date(Date.now() - TREND_WINDOW_DAYS * DAY_MS).toISOString();
  const [scopesRes, activity, readActivity, usage] = await Promise.all([
    listScopesRequest(token, signal),
    activityRequest(token, { bucket: 'hour', since }, signal),
    readActivityRequest(token, { bucket: 'hour', since }, signal),
    usageRequest(token, { since }, signal),
  ]);

  const scopes: ScopeHealth[] = scopesRes.scopes
    .map(({ scope, count, last_activity }) => ({
      scope,
      type: scopeType(scope),
      label: scope.split('::').pop() ?? scope,
      total: count,
      // The endpoint sorts by count desc; the cards are ordered by recency,
      // which is what `aggregateByScope` used to do client-side.
      lastActivity: last_activity ?? '',
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  return {
    scopes,
    rows: trendRowsFromActivity(activity.buckets),
    readBuckets: readActivity.buckets,
    usageByTool: usage.by_tool,
  };
}

export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => fetchDashboardData(signal),
    // Overview data changes infrequently — 60 s default staleTime is appropriate.
    staleTime: 60_000,
  });
}
