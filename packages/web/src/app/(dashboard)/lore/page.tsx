'use client';

import { LoreExplorer } from '@/components/lore/LoreExplorer';
import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';
import { useScopeTree, useLoreData } from '@/lib/queries/lore';

export default function LorePage() {
  // useScopeTree: lightweight scope-only fetch — tree renders immediately while
  // the lesson list streams in separately via useMemories inside LoreExplorer.
  const { data: scopes, isLoading: scopesLoading, isError: scopesError } = useScopeTree();
  // useLoreData: full 500-row fetch used only for heatmapData (the 26-week
  // contribution graph). Runs in parallel — the heatmap can load after the
  // scope tree; the lesson list + feed stream in via useMemories separately.
  const { data: loreData } = useLoreData();

  const isLoading = scopesLoading;
  const isError = scopesError;

  return (
    <div className="flex flex-col gap-4">
      {/* Title is static — renders immediately, never skeletoned */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Find any memory your agents have written, filtered by scope, label, or date.
        </p>
      </div>

      {/* Only the explorer shell waits on the scope tree; lessons load separately.
          overflow-y-auto on mobile so the stacked lesson list is naturally
          scrollable; overflow-hidden on desktop so the two-panel layout's own
          inner scroll containers take over. */}
      <div className="flex-1 overflow-y-auto md:overflow-hidden">
        {isLoading ? (
          <LoreExplorerSkeleton />
        ) : isError || !scopes ? (
          <p className="text-sm text-[var(--color-content-secondary)]">
            Failed to load lore data. Please refresh the page.
          </p>
        ) : (
          <LoreExplorer
            scopes={scopes}
            heatmapData={loreData?.heatmapData ?? []}
          />
        )}
      </div>
    </div>
  );
}
