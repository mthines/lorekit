import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import { aggregateByScope, computeStatTrends, type StatTrends } from '@/lib/aggregations';
import type { ScopeHealth } from '@/components/dashboard/ScopeHealthCard';

export type { StatTrends };

export interface DashboardData {
  scopes: ScopeHealth[];
  totalLessons: number;
  /** Per-stat-card trend series (daily / hourly buckets). */
  trends: StatTrends;
}

const EMPTY_TREND = { points: [], changePct: 0 };
const EMPTY_TRENDS: StatTrends = { lessons: EMPTY_TREND, scopes: EMPTY_TREND, activity: EMPTY_TREND };

async function fetchDashboardData(): Promise<DashboardData> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('memories')
    .select('scope,key,created_at')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) {
    return { scopes: [], totalLessons: 0, trends: EMPTY_TRENDS };
  }

  // Normalise timestamps to UTC ISO once, reuse everywhere.
  const rows = data.map((row) => ({
    scope: row.scope as string,
    key: row.key as string,
    created_at: new Date(row.created_at as string).toISOString(),
  }));

  // Scope aggregation
  const aggregated = aggregateByScope(rows);
  const scopes: ScopeHealth[] = aggregated.map(({ scope, total, lastActivity }) => ({
    scope,
    type: scopeType(scope),
    label: scope.split('::').pop() ?? scope,
    total,
    lastActivity,
  }));

  // Per-stat-card trend series (daily / hourly buckets).
  const trends = computeStatTrends(rows, new Date().toISOString());

  return { scopes, totalLessons: data.length, trends };
}

export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
    // Overview data changes infrequently — 60 s default staleTime is appropriate.
    staleTime: 60_000,
  });
}
