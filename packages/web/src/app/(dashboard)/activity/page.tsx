'use client';

import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed } from '@/components/activity/ActivityFeed';
import { useActivityData } from '@/lib/queries/activity';
import ActivityLoading from './loading';

export default function ActivityPage() {
  const { data, isLoading, isError } = useActivityData();

  if (isLoading) return <ActivityLoading />;

  if (isError || !data) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-[var(--color-content-secondary)]">
          Failed to load activity data. Please refresh the page.
        </p>
      </div>
    );
  }

  const { events, heatmapData } = data;

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
