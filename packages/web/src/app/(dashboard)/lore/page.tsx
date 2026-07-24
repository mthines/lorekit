'use client';

import { LoreExplorer } from '@/components/lore/LoreExplorer';
import { useLoreData } from '@/lib/queries/lore';
import LoreLoading from './loading';

export default function LorePage() {
  const { data, isLoading, isError } = useLoreData();

  if (isLoading) return <LoreLoading />;

  if (isError || !data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-content-secondary)]">
          Failed to load lore data. Please refresh the page.
        </p>
      </div>
    );
  }

  const { scopes, lessons } = data;

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
        {/* LoreExplorer reads ?scope= from URL via useUrlState internally,
            so ScopeHealthCard links like /lore?scope=my-scope auto-select
            the correct scope without any prop drilling. */}
        <LoreExplorer scopes={scopes} lessons={lessons} />
      </div>
    </div>
  );
}
