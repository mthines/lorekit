// Shown instantly on navigation to /activity.
export default function ActivityLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <div className="h-8 w-28 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
        <div className="mt-1.5 h-4 w-64 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Heatmap card skeleton */}
      <div className="h-36 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />

      {/* Feed skeleton */}
      <div className="flex flex-col gap-3">
        {/* Filter pills */}
        <div className="flex gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-6 w-20 animate-pulse rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
        {/* Event rows */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        ))}
      </div>
    </div>
  );
}
