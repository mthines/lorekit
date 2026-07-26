'use client';

import { LoreExplorer } from '@/components/lore/LoreExplorer';
import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';
import { useScopeTree } from '@/lib/queries/lore';

export default function LorePage() {
  const { data: scopes, isLoading, isError } = useScopeTree();

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

      {/* Only the explorer shell waits on the scope tree; lessons load separately */}
      <div className="flex-1 overflow-hidden" style={{ minHeight: '400px' }}>
        {isLoading ? (
          <LoreExplorerSkeleton />
        ) : isError || !scopes ? (
          <p className="text-sm text-[var(--color-content-secondary)]">
            Failed to load lore data. Please refresh the page.
          </p>
        ) : (
          <LoreExplorer scopes={scopes} />
        )}
      </div>
    </div>
  );
}
