import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import type { ActivityEvent } from '@/components/activity/ActivityFeed';

export interface ActivityData {
  events: ActivityEvent[];
  heatmapData: { date: string; count: number }[];
}

async function fetchActivityData(): Promise<ActivityData> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error || !data) return { events: [], heatmapData: [] };

  const events: ActivityEvent[] = data.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    scope: row.scope as string,
    scope_type: scopeType(row.scope as string),
    key: row.key as string,
    value_preview: ((row.value as string) ?? '').slice(0, 120),
    source_agent: row.source_agent as string | null,
    trigger: row.trigger as string | null,
    tags: (row.tags as string[]) ?? [],
    created_at: row.created_at as string,
  }));

  // Aggregate by day for the contribution heatmap.
  const dayCounts = new Map<string, number>();
  for (const e of events) {
    const day = e.created_at.slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }
  const heatmapData = Array.from(dayCounts.entries()).map(([date, count]) => ({ date, count }));

  return { events, heatmapData };
}

export function useActivityData() {
  return useQuery<ActivityData>({
    queryKey: ['activity'],
    queryFn: fetchActivityData,
    // Activity data changes frequently — keep it fresh for 30 s.
    staleTime: 30_000,
  });
}
