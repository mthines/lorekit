// Route-level loading fallback — shown on first navigation before any JS hydrates.
// Title renders as real text so users can read it instantly.
export default function ActivityLoading() {
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

      {/* Heatmap skeleton */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
        <div className="mb-4 h-3 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="h-20 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Feed skeleton */}
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
    </div>
  );
}
