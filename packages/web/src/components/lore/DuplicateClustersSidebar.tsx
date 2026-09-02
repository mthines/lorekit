'use client';

/**
 * DuplicateClustersSidebar — the Duplicate Clusters trigger's (`DuplicateClusters.tsx`)
 * body: a left column, laid out as an ordinary flex sibling of the results card
 * (see `LoreExplorer.tsx`), never a modal. There is deliberately no backdrop —
 * a reader picks a cluster here and then clicks lessons in the list beside it,
 * so dimming or intercepting clicks on the rest of the page would fight the
 * exact workflow this exists for.
 *
 * ## Selecting swaps the LIST, not a nested detail pane
 *
 * The previous shape held a second column inside this same panel — the
 * selected cluster's members, with their own stepper — because opening a
 * member meant reaching into the Explorer's detail sheet from here. That is
 * gone: picking a cluster now drives `LoreExplorer`'s own list (`renderResults`)
 * to show exactly that cluster's members, using the SAME `LessonCard` every
 * other lesson renders with. One place to look at a lesson, not two.
 *
 * `selectedClusterId`/`onSelectCluster` are controlled by the parent for
 * exactly that reason — the parent is what re-points the list.
 */

import { CopyCheck, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/Button';
import { useDuplicateClusters } from '@/lib/queries/duplicate-clusters';
import {
  clusterId,
  recurrenceLabel,
  similarityLabel,
  sizeLabel,
  windowSaturated,
} from '@/lib/duplicate-clusters-view';
import type { DuplicateCluster } from '@lorekit/schemas/memory';

interface DuplicateClustersSidebarProps {
  /** The Explorer's selected scope, or `null` for every scope the viewer can see. */
  scope: string | null;
  /** Human label for the current scope, for the sidebar's captions. */
  scopeLabel: string;
  /** The natural id ({@link clusterId}) of the cluster currently driving the list, or null. */
  selectedClusterId: string | null;
  /** Picks (or re-clicking the held one, clears) the cluster the list shows. */
  onSelectCluster: (cluster: DuplicateCluster | null) => void;
  onClose: () => void;
}

export function DuplicateClustersSidebar({
  scope,
  scopeLabel,
  selectedClusterId,
  onSelectCluster,
  onClose,
}: DuplicateClustersSidebarProps) {
  // Always enabled: this component only mounts while the trigger is open, so
  // there is no separate disclosure to gate on here.
  const { data, isLoading, isError } = useDuplicateClusters({ scope, enabled: true });
  const clusters = data?.clusters ?? [];
  const saturated = windowSaturated(data);

  function handleClusterClick(cluster: DuplicateCluster) {
    const id = clusterId(cluster);
    onSelectCluster(id === selectedClusterId ? null : cluster);
  }

  return (
    <aside
      id="explorer-clusters-sidebar"
      aria-label="Duplicate clusters"
      className="flex w-full shrink-0 flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3 md:w-72"
    >
      <div className="flex items-center gap-2">
        <CopyCheck className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <h2 className="text-xs font-medium text-[var(--color-content-secondary)]">
          Duplicate clusters
        </h2>
        {/* ml-auto lives on the wrapper, not the IconButton: a positioning
            class passed to IconButton lands on the inner <button>, while the
            Tooltip wrapper span is the actual flex child that must be pushed. */}
        <div className="ml-auto">
          <IconButton
            variant="ghost"
            size="sm"
            analyticsId="duplicate-clusters.close"
            onClick={onClose}
            label="Hide duplicate clusters"
            icon={<X className="size-3.5" aria-hidden />}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
          ))}
        </div>
      ) : isError ? (
        // NEVER fold a failed request into the empty state: "no duplicates" is
        // the reassuring reading, and rendering it for a broken sidebar hides
        // the defect completely.
        <p className="text-xs text-[var(--color-content-secondary)]">
          Failed to load duplicate clusters. Please refresh the page to try again.
        </p>
      ) : clusters.length === 0 ? (
        <p className="text-xs text-[var(--color-content-tertiary)]">
          No near-duplicate lessons in {scopeLabel}
          {saturated ? ' among the most recently written ones' : ''}.
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Duplicate clusters"
          className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto"
        >
          {clusters.map((cluster) => {
            const id = clusterId(cluster);
            const isSelected = id === selectedClusterId;
            const recurrence = recurrenceLabel(cluster);
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => handleClusterClick(cluster)}
                className={[
                  'flex w-full flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors duration-150',
                  isSelected
                    ? 'border-[var(--color-accent)] bg-[var(--color-bg-elevated)]'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-content-tertiary)]',
                ].join(' ')}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="font-medium text-[var(--color-content-primary)]">
                    {sizeLabel(cluster.size)}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-[var(--color-content-tertiary)]">
                    linked at {similarityLabel(cluster.min_similarity, cluster.max_similarity)}
                  </span>
                </span>
                {recurrence && (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge variant={recurrence.partial ? 'amber' : 'purple'}>
                      {recurrence.name}
                    </Badge>
                    {recurrence.partial && (
                      <span className="text-[10px] text-[var(--color-content-tertiary)]">
                        partial · {recurrence.matched} of {cluster.size} match
                      </span>
                    )}
                  </span>
                )}
                <span className="w-full truncate font-mono text-[10px] text-[var(--color-content-tertiary)]">
                  {cluster.members.map((m) => m.key).join(', ')}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* The two things a reader must not have to infer: this panel never
          changes anything, and it answered a WINDOWED question when the
          candidate window was full. */}
      {data && !isError && (
        <p className="text-[10px] leading-relaxed text-[var(--color-content-tertiary)]">
          Read-only — nothing here merges, edits or deletes lore.{' '}
          {saturated ? (
            <>
              Clustered over the {data.candidate_limit} most recently updated lessons in{' '}
              {scopeLabel} — recent duplicates only. Run{' '}
              <code className="font-mono text-[var(--color-content-secondary)]">
                lorekit dedupe
              </code>{' '}
              for the whole store.
            </>
          ) : (
            <>Clustered over all {data.candidates} active lessons in {scopeLabel}.</>
          )}
        </p>
      )}
    </aside>
  );
}
