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
 * ## What each card follows
 *
 * | Card    | Endpoint                        | Follows |
 * |---------|---------------------------------|---------|
 * | Written | `GET /memories/activity`        | range + scope + dimension filters, all SERVER-side (migration 00063) |
 * | Scopes  | the same response               | the same — it counts the returned `rows`, so a selected scope collapses it to 1 |
 * | Read    | `GET /memories/read-activity`   | range + scope SERVER-side (`?scope=`, migration 00058) — NOT the dimension filters |
 * | Expired | `GET /memories/usage`           | range only — **never scope, never filters** |
 *
 * Written and Scopes carry the FULL predicate the list applies (via
 * `filtersToQueryParams`), so the header agrees with the list beneath it. Two
 * honest limitations remain, both surfaced in the UI rather than hidden here:
 *
 * 1. **Read cannot follow the dimension filters.** `usage_events` records a
 *    read's scope (00058) but not the tags/repo of the memories it returned, so a
 *    label/repo filter is unanswerable for reads — the Read card is scope-level.
 * 2. **Expiry has no scope dimension at all.** The purge is per-user and spans
 *    scopes, so `usage_events` records no scope on `memory.expired`. The Expired
 *    figure is account-wide for the window even with a scope selected.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { activityRequest, readActivityRequest, usageRequest } from '@/lib/api/memories';
import { trendRowsFromActivity, type CountBucketRow, type TrendRow } from '@/lib/aggregations';
import type { ActivityQuery } from '@lorekit/schemas/memory';
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
 * accounts that can least afford it. 90 days is a deliberate bounded horizon —
 * wide enough to read as "recent history" yet a fixed cost regardless of account
 * age. It is intentionally WIDER than any preset the picker offers (24h/7d/30d),
 * so switching off "All" to the widest bounded preset visibly narrows the chart
 * rather than leaving it unchanged.
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
  // A malformed range is already absorbed above: `resolveRange` returns null for
  // it, so `effectiveStatsRange` substitutes the bounded 90-day default and this
  // resolves. The arm below is therefore unreachable unless the `90d` preset
  // itself stops resolving — a programming error, not caller input. It returns an
  // EMPTY window (`since === until`) on purpose: the header then charts nothing
  // rather than crashing, and nothing is more honest than a fabricated span the
  // captions would misdescribe.
  if (window) return { since: window.from, until: window.to };
  const now = Date.parse(nowIso);
  return { since: new Date(now).toISOString(), until: new Date(now).toISOString() };
}

async function fetchExplorerStats(
  scope: string | null,
  filters: Partial<ActivityQuery>,
  bucket: BucketUnit,
  since: string,
  until: string,
  signal?: AbortSignal,
): Promise<ExplorerStatsData> {
  const token = await browserAccessToken();
  if (!token) return EMPTY;

  const [activity, readActivity, usage] = await Promise.all([
    // Scope AND the dimension filters go to the SERVER now (migration 00063):
    // the response is aggregated per (bucket, scope) and carries no per-memory
    // tag/agent/repo, so a dimension filter CANNOT be applied client-side — the
    // written/scopes counts have to be narrowed in the RPC to agree with the list.
    activityRequest(token, { bucket, since, until, ...(scope ? { scope } : {}), ...filters }, signal),
    // Read follows scope + range ONLY: usage_events has no per-memory dimension,
    // so a label/repo filter is unanswerable for reads (the Read card is
    // scope-level by design). `scope` still goes server-side (00058) because the
    // read series carries a NULL-scope remainder that client filtering would fold
    // in or out depending on how the predicate was written.
    readActivityRequest(token, { bucket, since, until, ...(scope ? { scope } : {}) }, signal),
    usageRequest(token, { since, until }, signal),
  ]);

  return {
    // No client-side scope filter: the server already returns exactly the scope
    // (and dimension) selection, so re-filtering here would double-apply it.
    rows: trendRowsFromActivity(activity.buckets),
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
  filters: Partial<ActivityQuery>,
  bucket: BucketUnit,
  since: string,
  until: string,
) {
  return useQuery<ExplorerStatsData>({
    // `filters` is a plain object; React Query's default hash sorts its keys, so
    // the same filter set always produces the same key regardless of insertion
    // order — the header refetches when (and only when) the predicate changes.
    queryKey: ['explorer-stats', scope, filters, bucket, since, until],
    queryFn: ({ signal }) => fetchExplorerStats(scope, filters, bucket, since, until, signal),
    placeholderData: keepPreviousData,
    // Matches the lesson list's staleTime: the two are read together and a
    // header that refreshed on a different cadence than the list under it would
    // show numbers that disagree with what the reader can count on screen.
    staleTime: 90_000,
  });
}
