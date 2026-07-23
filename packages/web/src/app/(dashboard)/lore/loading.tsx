// Shown instantly on navigation to /lore.
export default function LoreLoading() {
  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div>
        <div className="h-8 w-40 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
        <div className="mt-1.5 h-4 w-72 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Explorer shell */}
      <div
        className="flex overflow-hidden rounded-xl border border-[var(--color-border)]"
        style={{ height: 'calc(100vh - 11rem)' }}
      >
        {/* Scope tree skeleton */}
        <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3 gap-1.5">
          <div className="mb-2 h-3 w-16 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-7 animate-pulse rounded-md bg-[var(--color-bg-elevated)]"
              style={{ width: `${60 + (i % 3) * 15}%` }}
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
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
