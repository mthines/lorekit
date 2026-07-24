// Route-level loading fallback — shown on first navigation before the server
// component resolves. Title renders as real text so it's immediately readable.
export default function DashboardLoading() {
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

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        ))}
      </div>

      {/* Sparkline skeleton */}
      <div className="h-36 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />

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
