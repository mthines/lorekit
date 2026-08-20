'use client';

import { LoreExplorer } from '@/components/lore/LoreExplorer';
import { LoreExplorerSkeleton } from '@/components/lore/LoreExplorerSkeleton';
import { useScopeTree, useLoreData, isNotAuthenticated } from '@/lib/queries/lore';

export default function LorePage() {
  // useScopeTree: lightweight scope-only fetch — tree renders immediately while
  // the lesson list streams in separately via useMemories inside LoreExplorer.
  const { data: scopes, isLoading: scopesLoading, isError: scopesError, error: scopesErr } = useScopeTree();
  // useLoreData: the legacy combined fetch, kept only for heatmapData (the
  // contribution graph), which now comes from `GET /memories/activity`
  // — bucketed in Postgres, so it is not bounded by the page it ships with
  // (`LEGACY_PAGE_SIZE` in queries/lore.ts owns that size). Runs in parallel —
  // the heatmap can load after the scope tree; the lesson list + feed stream in
  // via useMemories separately.
  const { data: loreData } = useLoreData();

  const isLoading = scopesLoading;
  const isError = scopesError;
  // A lapsed or absent session is not a failure to retry — "refresh the page"
  // is advice that cannot work, so it gets its own copy and a way out.
  const signedOut = isNotAuthenticated(scopesErr);

  return (
    // Capped and left-aligned so the stat columns, heatmap and list do not
    // stretch edge-to-edge on an ultrawide display, where four cards spread
    // across ~1900px read as sparse and each memory line runs too long to scan.
    // Below the cap the page is full-width as before, so laptops are unaffected.
    // `max-w-page` is the SHARED cap (`--container-page` in globals.css) that
    // Overview uses too — the two wide dashboard shells must agree, otherwise
    // navigating between them shifts the content edge.
    <div className="flex max-w-page flex-col gap-4">
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
        ) : signedOut ? (
          <p className="text-sm text-[var(--color-content-secondary)]">
            Your session has expired.{' '}
            <a
              href="/login?next=/lore"
              className="inline-flex min-h-11 items-center text-[var(--color-accent)] underline underline-offset-2"
            >
              Sign in again
            </a>{' '}
            to see your lore.
          </p>
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
