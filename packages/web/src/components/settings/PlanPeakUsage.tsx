'use client';

/**
 * PlanPeakUsage — "peaked at N in the last 30 days", from
 * `GET /memories/usage`'s `summary.peak_memory_count` (migration 00081).
 *
 * Complements {@link PlanUsageBar}, which shows the LIVE count via the
 * pre-existing `lorekit_memory_count()` server action — that answers "how
 * full am I right now"; this answers "how full WAS I over the last month",
 * from `usage_events.memory_count`'s write-time snapshots. Goes through the
 * REST API (`usageRequest`), unlike the legacy `getPlanUsage()` server
 * action, which predates the "dashboard is a REST client" rule and is not
 * this PR's job to migrate.
 *
 * Renders nothing while loading or when the window has no write events —
 * this is a bonus caption, not a load-bearing figure worth a skeleton.
 */

import { useQuery } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import { usageRequest } from '@/lib/api/memories';

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

async function fetchPeak(): Promise<number | null> {
  const token = await browserAccessToken();
  if (!token) return null;
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString();
  const response = await usageRequest(token, { since });
  return response.summary.peak_memory_count ?? null;
}

export function PlanPeakUsage() {
  const { data: peak } = useQuery({
    queryKey: ['plan-peak-usage'],
    queryFn: fetchPeak,
    staleTime: 60_000,
  });

  if (peak == null) return null;

  return (
    <p className="text-xs text-[var(--color-content-tertiary)]">
      Peaked at {peak.toLocaleString()} memories in the last {WINDOW_DAYS} days.
    </p>
  );
}
