// Skeleton for the data-only part of the Lore Explorer.
// Used by lore/page.tsx inline (so the title stays visible while data loads)
// and by lore/loading.tsx (route-level fallback on first navigation).
export function LoreExplorerSkeleton() {
  return (
    <div
      className="flex overflow-hidden rounded-xl border border-[var(--color-border)]"
      style={{ height: 'calc(100vh - 11rem)' }}
    >
      {/* Scope tree skeleton */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3 gap-1.5">
        <div className="mb-2 h-3 w-16 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        {[60, 75, 90, 70, 85, 65, 80, 60].map((w, i) => (
          <div
            key={i}
            className="h-7 animate-pulse rounded-md bg-[var(--color-bg-elevated)]"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>

      {/* Lesson list skeleton */}
      <div className="flex flex-1 flex-col gap-0 overflow-hidden">
        {/* Search bar */}
        <div className="border-b border-[var(--color-border)] p-3">
          <div className="h-8 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]" />
        </div>
        {/* Cards */}
        <div className="flex flex-col gap-2 overflow-hidden p-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      </div>
    </div>
  );
}
