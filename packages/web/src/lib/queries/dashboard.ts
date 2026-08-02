import { useQuery } from '@tanstack/react-query';
import { scopeType } from '@/lib/scope';
import { trendRowsFromActivity, type TrendRow } from '@/lib/aggregations';
import type { ScopeHealth } from '@/components/dashboard/ScopeHealthCard';
import { browserAccessToken } from '@/lib/api/session-browser';
import { activityRequest, listScopesRequest } from '@/lib/api/memories';

export interface DashboardData {
  scopes: ScopeHealth[];
  totalLessons: number;
  /**
   * Raw trend rows (scope + created_at), one per memory in the trend window.
   * The stat cards compute their per-card range trends from these client-side,
   * so switching a card's range (24h / 7d / 30d) never triggers a refetch.
   */
  rows: TrendRow[];
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
 */
async function fetchDashboardData(signal?: AbortSignal): Promise<DashboardData> {
  const token = await browserAccessToken();
  if (!token) return { scopes: [], totalLessons: 0, rows: [] };

  const since = new Date(Date.now() - TREND_WINDOW_DAYS * DAY_MS).toISOString();
  const [scopesRes, activity] = await Promise.all([
    listScopesRequest(token, signal),
    activityRequest(token, { bucket: 'hour', since }, signal),
  ]);

  const scopes: ScopeHealth[] = scopesRes.scopes
    .map(({ scope, count, last_activity }) => ({
      scope,
      type: scopeType(scope),
      label: scope.split('::').pop() ?? scope,
      total: count,
      // The endpoint sorts by scope; the cards are ordered by recency, which
      // is what `aggregateByScope` used to do client-side.
      lastActivity: last_activity ?? '',
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  return {
    scopes,
    // Summing exact per-scope counts, not counting fetched rows — the figure is
    // now correct above the row cap that used to silently truncate it.
    totalLessons: scopesRes.scopes.reduce((sum, s) => sum + s.count, 0),
    rows: trendRowsFromActivity(activity.buckets),
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
