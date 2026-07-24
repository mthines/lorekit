import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';

// Route-level loading fallback — shown on first navigation before any JS hydrates.
// Title renders as real text so users can read it instantly.
export default function LoreLoading() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Browse and search your agents&apos; accumulated lessons by scope.
        </p>
      </div>

      <div className="flex-1 overflow-hidden" style={{ minHeight: '400px' }}>
        <LoreExplorerSkeleton />
      </div>
    </div>
  );
}
