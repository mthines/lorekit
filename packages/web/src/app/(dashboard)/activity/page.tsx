'use client';

import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed } from '@/components/activity/ActivityFeed';
import { useActivityData } from '@/lib/queries/activity';
import ActivityLoading from './loading';

const FETCH_LIMIT = 200;

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
  const isTruncated = events.length >= FETCH_LIMIT;

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
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
            Lessons written — last 26 weeks
          </p>
          {isTruncated && (
            <p className="text-[10px] text-[var(--color-content-tertiary)]">
              Heatmap reflects the most recent {FETCH_LIMIT} events
            </p>
          )}
        </div>
        <ContributionHeatmap data={heatmapData} weeks={26} />
      </div>

      {/* Feed */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
            Recent events
          </p>
          <p className="text-[10px] text-[var(--color-content-tertiary)]">
            {events.length}{isTruncated ? ` (latest ${FETCH_LIMIT})` : ' total'}
          </p>
        </div>
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}
