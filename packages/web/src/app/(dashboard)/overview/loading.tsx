// Route-level loading fallback — shown on first navigation before the server
// component resolves. Title renders as real text so it's immediately readable.
export default function OverviewLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Overview
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Your agents&apos; accumulated knowledge at a glance.
        </p>
      </div>

      {/* Onboarding checklist skeleton */}
      <div className="h-14 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />

      {/* Summary stats — mirrors DashboardStatsSkeleton: a label + range-select
          row above the grid (so the stats block doesn't shift down when the real
          component mounts), then the same responsive grid + card height
          (`grid-cols-1 sm:grid-cols-3`, `h-40`) as the real DashboardStats. */}
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          <div className="h-6 w-28 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      </div>

      {/* Scope health grid */}
      <div>
        <div className="mb-3 h-3 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      </div>
    </div>
  );
}
