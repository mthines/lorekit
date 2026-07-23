// Shown instantly on navigation — before the dashboard server component fetches data.
// Shape matches the real page to prevent layout shift.
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <div className="h-8 w-36 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
        <div className="mt-1.5 h-4 w-64 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Onboarding skeleton */}
      <div className="h-14 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        ))}
      </div>

      {/* Scope health grid */}
      <div>
        <div className="mb-3 h-3 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      </div>
    </div>
  );
}
