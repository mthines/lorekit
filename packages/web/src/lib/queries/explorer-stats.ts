'use client';

/**
 * The Lore Explorer's stats header data.
 *
 * Distinct from `useDashboardData`, which fetches ONE wide window once and
 * re-buckets client-side so the Overview's range picker never refetches. That
 * trick does not transfer: the Explorer's header follows a scope selection and
 * a range that can be any absolute window, so the window itself is the query.
 * It therefore fetches per selection and leans on TanStack's cache instead.
 *
 * ## What is and is not scoped
 *
 * | Card    | Endpoint                        | Scoped by |
 * |---------|---------------------------------|-----------|
 * | Written | `GET /memories/activity`        | range, and scope CLIENT-side (the response is per `(bucket, scope)`) |
 * | Scopes  | the same response               | range, and scope CLIENT-side — it counts the same `rows`, so a selected scope collapses it to 1 |
 * | Read    | `GET /memories/read-activity`   | range, and scope SERVER-side (`?scope=`, migration 00058) |
 * | Expired | `GET /memories/usage`           | range only — **never scope** |
 *
 * Two honest limitations follow, and both are surfaced in the UI rather than
 * hidden here:
 *
 * 1. **Expiry has no scope dimension.** The purge is per-user and spans scopes,
 *    so `usage_events` records no scope on `memory.expired` (PR-1 deferred it
 *    deliberately). The Expired figure is account-wide for the window even with
 *    a scope selected.
 * 2. **The filter bar does not narrow these numbers.** `/activity`,
 *    `/read-activity` and `/usage` accept a window (and `/read-activity` a
 *    scope); none accepts the Explorer's dimension filters. Making the header
 *    follow the bar needs those params server-side — a backend change, not a
 *    frontend one. Until then the header describes the SCOPE and the RANGE, and
 *    says so when a filter bar is active.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { activityRequest, readActivityRequest, usageRequest } from '@/lib/api/memories';
import { trendRowsFromActivity, type CountBucketRow, type TrendRow } from '@/lib/aggregations';
import { resolveRange, type BucketUnit, type TimeRange } from '@/lib/time-range';

export interface ExplorerStatsData {
  /** One row per memory written in the window (scope-filtered when one is selected). */
  rows: TrendRow[];
  /** Records read per bucket, already restricted to the selected scope server-side. */
  readBuckets: CountBucketRow[];
  /** Memory records expired in the window. Account-wide — see the module docblock. */
  expired: number;
}

const EMPTY: ExplorerStatsData = { rows: [], readBuckets: [], expired: 0 };

/**
 * What the header charts when the Explorer's range is UNBOUNDED.
 *
 * "All time" is a legitimate selection for a LIST and not one for a chart:
 * `/activity` would return every bucket the account has ever produced to draw
 * something a few hundred pixels wide, and the cost lands on exactly the
 * accounts that can least afford it. 90 days is the widest preset the picker
 * offers, so an unbounded selection charts the same span the widest bounded one
 * does.
 *
 * **It substitutes the RANGE, not just the query window**, and that distinction
 * is the point: the cards must caption what they actually counted. Capping the
 * fetch while still captioning "in all time" would print "142 memories written
 * in all time" for an account with thousands — a number that is not wrong so
 * much as answering a different question than the one it claims to.
 */
export const UNBOUNDED_STATS_RANGE: TimeRange = { preset: '90d' };

/**
 * The range the header actually describes: the selection, unless it is
 * unbounded, in which case {@link UNBOUNDED_STATS_RANGE}.
 *
 * Every downstream derivation — the query window, the bucket grid, the grid
 * anchor and the captions — is taken from THIS rather than from the raw
 * selection, so the four cards and their labels cannot describe different
 * periods.
 */
export function effectiveStatsRange(range: TimeRange, nowIso: string): TimeRange {
  return resolveRange(range, nowIso) === null ? UNBOUNDED_STATS_RANGE : range;
}

/**
 * Resolve the window to query for, in the form the endpoints take.
 *
 * Exported for the test that pins the unbounded fallback: an unbounded range
 * silently becoming "all of history" is a performance cliff that only shows up
 * on the biggest accounts.
 */
export function statsWindow(
  range: TimeRange,
  nowIso: string,
): { since: string; until: string } {
  const window = resolveRange(effectiveStatsRange(range, nowIso), nowIso);
  // `effectiveStatsRange` guarantees a bounded range, so this cannot be null —
  // but fall back rather than assert, because a caller passing a malformed
  // range should get a usable window, not a crash in a header.
  if (window) return { since: window.from, until: window.to };
  const now = Date.parse(nowIso);
  return { since: new Date(now).toISOString(), until: new Date(now).toISOString() };
}

async function fetchExplorerStats(
  scope: string | null,
  bucket: BucketUnit,
  since: string,
  until: string,
  signal?: AbortSignal,
): Promise<ExplorerStatsData> {
  const token = await browserAccessToken();
  if (!token) return EMPTY;

  const [activity, readActivity, usage] = await Promise.all([
    activityRequest(token, { bucket, since, until }, signal),
    // `scope` goes to the SERVER here (00058) rather than being filtered after,
    // because the read series carries a NULL-scope remainder for reads whose
    // scope could not be resolved — filtering client-side would silently fold
    // that remainder in or out depending on how the predicate was written.
    readActivityRequest(token, { bucket, since, until, ...(scope ? { scope } : {}) }, signal),
    usageRequest(token, { since, until }, signal),
  ]);

  return {
    rows: trendRowsFromActivity(activity.buckets, scope),
    readBuckets: readActivity.buckets,
    expired: usage.summary.expired,
  };
}

/**
 * Fetch the header's four figures for the current selection.
 *
 * `keepPreviousData` is what lets the header hold its last render while a new
 * selection loads: without it every scope click blanks four cards to skeletons
 * and the surrounding layout jumps, which reads as the page breaking rather
 * than as it working. The caller dims the held render (`isFetching`) so the
 * staleness is visible without the frame moving.
 */
export function useExplorerStats(
  scope: string | null,
  bucket: BucketUnit,
  since: string,
  until: string,
) {
  return useQuery<ExplorerStatsData>({
    queryKey: ['explorer-stats', scope, bucket, since, until],
    queryFn: ({ signal }) => fetchExplorerStats(scope, bucket, since, until, signal),
    placeholderData: keepPreviousData,
    // Matches the lesson list's staleTime: the two are read together and a
    // header that refreshed on a different cadence than the list under it would
    // show numbers that disagree with what the reader can count on screen.
    staleTime: 90_000,
  });
}
