import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import { aggregateByScope, type TrendRow } from '@/lib/aggregations';
import type { ScopeHealth } from '@/components/dashboard/ScopeHealthCard';

export interface DashboardData {
  scopes: ScopeHealth[];
  totalLessons: number;
  /**
   * Raw trend rows (scope + created_at), newest first. The stat cards compute
   * their per-card range trends from these client-side, so switching a card's
   * range (24h / 7d / 30d) never triggers a refetch.
   */
  rows: TrendRow[];
}

async function fetchDashboardData(): Promise<DashboardData> {
  const supabase = createClient();

  // Filter to active (non-archived), non-expired memories only — consistent
  // with the plan-page count and the cap trigger's definition of "active".
  // The previous query had no archived_at filter, so archived memories were
  // included in the dashboard total while the plan page excluded them.
  const { data, error } = await supabase
    .from('memories')
    .select('scope,key,created_at')
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) {
    return { scopes: [], totalLessons: 0, rows: [] };
  }

  // Normalise timestamps to UTC ISO once, reuse everywhere.
  const rows: TrendRow[] = data.map((row) => ({
    scope: row.scope as string,
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

  return { scopes, totalLessons: data.length, rows };
}

export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
    // Overview data changes infrequently — 60 s default staleTime is appropriate.
    staleTime: 60_000,
  });
}
