import type { Metadata } from 'next';
import { createServerClient } from '@/lib/supabase/server';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed, type ActivityEvent } from '@/components/activity/ActivityFeed';
import { scopeType } from '@lorekit/core';

export const metadata: Metadata = { title: 'Activity' };

async function fetchActivityData(supabase: Awaited<ReturnType<typeof createServerClient>>) {
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

  // Aggregate by day for heatmap
  const dayCounts = new Map<string, number>();
  for (const e of events) {
    const day = e.created_at.slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }
  const heatmapData = Array.from(dayCounts.entries()).map(([date, count]) => ({ date, count }));

  return { events, heatmapData };
}

export default async function ActivityPage() {
  const supabase = await createServerClient();
  const { events, heatmapData } = await fetchActivityData(supabase);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Activity
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          What your agents have been learning, day by day.
        </p>
      </div>

      {/* Heatmap card */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
        <p className="mb-4 text-xs font-medium text-[var(--color-content-tertiary)]">
          Lessons written — last 26 weeks
        </p>
        <ContributionHeatmap data={heatmapData} weeks={26} />
      </div>

      {/* Feed */}
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
          All events · {events.length} total
        </p>
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}
