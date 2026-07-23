import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import type { ScopeHealth } from '@/components/dashboard/ScopeHealthCard';

export interface DashboardData {
  scopes: ScopeHealth[];
  totalLessons: number;
}

async function fetchDashboardData(): Promise<DashboardData> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('memories')
    .select('scope,created_at,updated_at')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) return { scopes: [], totalLessons: 0 };

  // Aggregate per scope.
  const scopeMap = new Map<string, { total: number; lastActivity: string }>();
  for (const row of data) {
    const scope = row.scope as string;
    const existing = scopeMap.get(scope);
    const ts = row.created_at as string;
    if (!existing || ts > existing.lastActivity) {
      scopeMap.set(scope, {
        total: (existing?.total ?? 0) + 1,
        lastActivity: ts,
      });
    } else {
      existing.total++;
    }
  }

  const scopes: ScopeHealth[] = Array.from(scopeMap.entries())
    .sort(([, a], [, b]) => b.lastActivity.localeCompare(a.lastActivity))
    .map(([scope, { total, lastActivity }]) => ({
      scope,
      type: scopeType(scope),
      label: scope.split('::').pop() ?? scope,
      total,
      lastActivity,
    }));

  return { scopes, totalLessons: data.length };
}

export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
    // Overview data changes infrequently — 60 s default staleTime is appropriate.
    staleTime: 60_000,
  });
}
