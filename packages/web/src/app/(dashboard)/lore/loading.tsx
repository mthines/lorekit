import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';

// Route-level loading fallback — shown on first navigation before any JS hydrates.
// Title renders as real text so users can read it instantly.
export default function LoreLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Find any lesson your agents have written, filtered by scope or date.
        </p>
      </div>

      {/* Heatmap panel skeleton */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
        <div className="mb-4 h-3 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="h-20 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Tab bar skeleton */}
      <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-1">
        <div className="h-9 flex-1 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
        <div className="h-9 flex-1 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
      </div>

      <LoreExplorerSkeleton />
    </div>
  );
}
