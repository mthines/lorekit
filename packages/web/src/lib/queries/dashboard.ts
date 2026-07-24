import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import { aggregateByScope } from '@/lib/aggregations';
import type { ScopeHealth } from '@/components/dashboard/ScopeHealthCard';

/** Lesson count aggregated per ISO week (YYYY-Www). */
export interface WeekCount {
  week: string; // e.g. "2026-W29"
  count: number;
}

export interface DashboardData {
  scopes: ScopeHealth[];
  totalLessons: number;
  /** Last 12 weeks of lesson counts for the sparkline chart. */
  weeklyActivity: WeekCount[];
  /** The 5 most-recently active lessons for the quick-access list. */
  recentLessons: { scope: string; key: string; created_at: string }[];
}

/** Return the ISO week string (YYYY-Www) for a UTC date. */
function isoWeek(utcIso: string): string {
  const d = new Date(utcIso);
  // Thursday of the current week (ISO 8601: weeks start on Monday)
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function fetchDashboardData(): Promise<DashboardData> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('memories')
    .select('scope,key,created_at')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) {
    return { scopes: [], totalLessons: 0, weeklyActivity: [], recentLessons: [] };
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

  // Weekly activity — last 12 weeks.
  const weekMap = new Map<string, number>();
  for (const row of rows) {
    const w = isoWeek(row.created_at);
    weekMap.set(w, (weekMap.get(w) ?? 0) + 1);
  }
  // Build a full grid of the last 12 weeks so empty weeks appear as zero bars.
  const today = new Date();
  const weeklyActivity: WeekCount[] = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i * 7);
    const w = isoWeek(d.toISOString());
    return { week: w, count: weekMap.get(w) ?? 0 };
  }).reverse();

  // 5 most-recent lessons (already ordered desc from the query)
  const recentLessons = rows.slice(0, 5).map(({ scope, key, created_at }) => ({
    scope,
    key,
    created_at,
  }));

  return { scopes, totalLessons: data.length, weeklyActivity, recentLessons };
}

export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
    // Overview data changes infrequently — 60 s default staleTime is appropriate.
    staleTime: 60_000,
  });
}
