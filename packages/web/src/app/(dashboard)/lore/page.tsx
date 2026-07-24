'use client';

import { LoreExplorer } from '@/components/lore/LoreExplorer';
import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';
import { useLoreData } from '@/lib/queries/lore';

export default function LorePage() {
  const { data, isLoading, isError } = useLoreData();

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Title is static — renders immediately, never skeletoned */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Browse and search your agents&apos; accumulated lessons by scope.
        </p>
      </div>

      {/* Only the explorer shell waits on data */}
      <div className="flex-1 overflow-hidden" style={{ minHeight: '400px' }}>
        {isLoading ? (
          <LoreExplorerSkeleton />
        ) : isError || !data ? (
          <p className="text-sm text-[var(--color-content-secondary)]">
            Failed to load lore data. Please refresh the page.
          </p>
        ) : (
          <LoreExplorer scopes={data.scopes} lessons={data.lessons} />
        )}
      </div>
    </div>
  );
}
