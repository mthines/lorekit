'use client';

import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed } from '@/components/activity/ActivityFeed';
import { useActivityData } from '@/lib/queries/activity';

const FETCH_LIMIT = 200;

function HeatmapSkeleton() {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <div className="mb-4 h-3 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      <div className="h-20 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-6 w-20 animate-pulse rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
      ))}
    </div>
  );
}

export default function ActivityPage() {
  const { data, isLoading, isError } = useActivityData();

  return (
    <div className="flex flex-col gap-6">
      {/* Title is static — renders immediately, never skeletoned */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Activity
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          What your agents have been learning, day by day.
        </p>
      </div>

      {isLoading ? (
        <>
          <HeatmapSkeleton />
          <FeedSkeleton />
        </>
      ) : isError || !data ? (
        <p className="text-sm text-[var(--color-content-secondary)]">
          Failed to load activity data. Please refresh the page.
        </p>
      ) : (
        <>
          {/* Heatmap card */}
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
            <div className="mb-4 flex items-center justify-between gap-4">
              <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
                Lessons written — last 26 weeks
              </p>
              {data.events.length >= FETCH_LIMIT && (
                <p className="text-[10px] text-[var(--color-content-tertiary)]">
                  Heatmap reflects the most recent {FETCH_LIMIT} events
                </p>
              )}
            </div>
            <ContributionHeatmap data={data.heatmapData} weeks={26} />
          </div>

          {/* Feed */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
                Recent events
              </p>
              <p className="text-[10px] text-[var(--color-content-tertiary)]">
                {data.events.length}
                {data.events.length >= FETCH_LIMIT ? ` (latest ${FETCH_LIMIT})` : ' total'}
              </p>
            </div>
            <ActivityFeed events={data.events} />
          </div>
        </>
      )}
    </div>
  );
}
