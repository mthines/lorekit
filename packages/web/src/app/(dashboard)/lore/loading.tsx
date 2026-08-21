import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';

// Route-level loading fallback — shown on first navigation before any JS hydrates.
// Title renders as real text so users can read it instantly.
export default function LoreLoading() {
  return (
    // Same `max-w-page` cap as the real page — without it the skeleton renders
    // full-bleed on an ultrawide display and the content edge jumps inward the
    // moment the page mounts.
    <div className="flex max-w-page flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Find any memory your agents have written, filtered by scope, label, or date.
        </p>
      </div>

      {/* The scope strip, the (collapsed) insights panel and the results are all
          skeletoned by LoreExplorerSkeleton, which mirrors the real layout. There
          is no separate heatmap panel or view-mode tab bar any more — the heatmap
          lives inside the insights panel and only renders when it is expanded. */}
      <LoreExplorerSkeleton />
    </div>
  );
}
