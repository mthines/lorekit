'use client';

/**
 * Data fetch behind {@link LoreUtilityGrid} (`components/lore/LoreUtilityGrid.tsx`).
 *
 * A thin wrapper over `GET /memories/utility` — the RPCs already return the
 * census, the cost and the ranked page, so there is nothing to aggregate here.
 *
 * TWO HOOKS, ONE ROUTE, and the split is what keeps the page cheap. The census
 * and the cost are the same answer whichever quadrant a reader is standing in,
 * so re-fetching them on every quadrant click would re-run two aggregates to
 * redraw a row list. `useLoreUtility` asks for the counts alone;
 * `useLoreUtilityRows` asks for one quadrant's rows and its own key includes
 * the quadrant. The census in the second response is discarded — a duplicate
 * of what the first already holds, and the server computes it either way.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { utilityRequest } from '@/lib/api/memories';
import type { LessonUtilityName, UtilityResponse } from '@lorekit/schemas/memory';

/**
 * The shape a signed-out render sees.
 *
 * Deliberately all zeroes rather than `undefined`: the grid renders five
 * quadrants whether or not it has data, and a caller that has to distinguish
 * "no session" from "no lore" has `isLoading`/`isError` for it.
 */
const EMPTY: UtilityResponse = {
  thresholds: { min_deliveries: 0, min_age_days: 0, chosen_pull_through: 0, broad_reach_deliveries: 0 },
  counting_since: new Date(0).toISOString(),
  census: { 'load-bearing': 0, specialist: 0, 'noise-tax': 0, dormant: 0, unproven: 0 },
  cost: { delivered_reads: 0, chosen_reads: 0, delivered_tokens: 0, chosen_tokens: 0 },
  window: { since: null, until: null },
  quadrant: null,
  entries: [],
};

async function fetchUtility(
  params: { scope?: string; since?: string; until?: string; quadrant?: LessonUtilityName; limit?: number },
  signal?: AbortSignal,
): Promise<UtilityResponse> {
  const token = await browserAccessToken();
  if (!token) return { ...EMPTY, quadrant: params.quadrant ?? null };
  return utilityRequest(token, params, signal);
}

/** The census and the delivery cost — everything that does not depend on a quadrant. */
export function useLoreUtility(window: { since?: string; until?: string }, scope?: string) {
  return useQuery<UtilityResponse>({
    queryKey: ['lore-utility', 'census', scope ?? null, window.since ?? null, window.until ?? null],
    queryFn: ({ signal }) =>
      fetchUtility(
        { ...(scope ? { scope } : {}), ...(window.since ? { since: window.since } : {}),
          ...(window.until ? { until: window.until } : {}) },
        signal,
      ),
    placeholderData: keepPreviousData,
    staleTime: 90_000,
  });
}

/**
 * One quadrant's rows.
 *
 * `enabled` is what makes the pair cheap: with no quadrant selected the grid
 * shows counts only and this query never runs, the same posture the Explorer's
 * clusters sidebar takes (a closed panel issues no request).
 */
export function useLoreUtilityRows(quadrant: LessonUtilityName | null, scope?: string, limit = 20) {
  return useQuery<UtilityResponse>({
    queryKey: ['lore-utility', 'rows', quadrant, scope ?? null, limit],
    queryFn: ({ signal }) =>
      fetchUtility({ quadrant: quadrant as LessonUtilityName, ...(scope ? { scope } : {}), limit }, signal),
    enabled: quadrant !== null,
    placeholderData: keepPreviousData,
    staleTime: 90_000,
  });
}
