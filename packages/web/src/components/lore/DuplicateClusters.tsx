'use client';

/**
 * DuplicateClusters — the compact trigger bar for the Explorer's Duplicate
 * Clusters sidebar. READ-ONLY, same contract as before: this surfaces evidence
 * of near-duplicate lessons and stops. There is no merge button, no delete, no
 * "clean up" — the same boundary `lorekit dedupe` and `lorekit invariants
 * candidates` keep on the CLI side and `GET /memories/clusters` keeps
 * server-side.
 *
 * ## Trigger, not a collapsible panel
 *
 * This used to be an inline `<section>` that expanded in place, pushing the
 * lesson list down for every reader regardless of whether they cared. It is now
 * a single-row toolbar-style trigger: pressing it opens `DuplicateClustersSidebar`
 * — a left column beside the list, NOT a modal (no backdrop, so a reader can
 * keep clicking lesson rows while it is open) — instead of growing this bar
 * itself. `open`/`onToggleOpen` are lifted to `LoreExplorer` because the sidebar
 * needs the same boolean to decide whether it renders at all.
 *
 * ## Why this stays a PANEL entry point, not an instrument
 *
 * `lib/explorer-instruments.ts` defines the instrument contract in two halves.
 * This surface passes the first — click something and you end up holding lore —
 * and fails the second: an instrument's every selection is written to the
 * `?filters=` bar, and "these five lessons are near-duplicates" is not a filter
 * dimension (it is a computed grouping over bodies, expressible in no pill).
 * So: Explorer yes, instrument no, sibling to `ExplorerInsights`/
 * `ExplorerInstruments` — this relitigates neither recorded decision.
 *
 * ## The count is still opt-in
 *
 * The summary badge only appears once the sidebar has been opened at least
 * once in this session: `useDuplicateClusters` stays `enabled: open`, so a
 * reader who never opens the sidebar never pays for the (quadratic-in-the-worst-
 * case, full-body) clustering read. The count is not always-on chrome.
 */

import { CopyCheck, ChevronRight } from 'lucide-react';
import { useDuplicateClusters } from '@/lib/queries/duplicate-clusters';
import { clustersSummary } from '@/lib/duplicate-clusters-view';

interface DuplicateClustersProps {
  /** The Explorer's selected scope, or `null` for every scope the viewer can see. */
  scope: string | null;
  /** Human label for the current scope, for the trigger's caption. */
  scopeLabel: string;
  /** Whether the sidebar is currently open — controlled by the caller. */
  open: boolean;
  /** Toggles the sidebar open/closed. */
  onToggleOpen: () => void;
}

export function DuplicateClusters({ scope, open, onToggleOpen }: DuplicateClustersProps) {
  // Folded means NOT FETCHED — see the docblock. This is the whole reason the
  // sidebar's open state reaches the query.
  const { data } = useDuplicateClusters({ scope, enabled: open });
  const summary = clustersSummary(data);

  return (
    <button
      type="button"
      onClick={onToggleOpen}
      aria-expanded={open}
      aria-controls={open ? 'explorer-clusters-sidebar' : undefined}
      className={[
        'flex min-h-11 w-full items-center gap-2 rounded-xl border px-4 py-2.5 text-left transition-colors duration-150',
        open
          ? 'border-[var(--color-accent)] bg-[var(--color-bg-raised)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] hover:border-[var(--color-content-tertiary)]',
      ].join(' ')}
    >
      <CopyCheck className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
      <span className="text-xs font-medium text-[var(--color-content-secondary)]">
        Duplicate clusters
      </span>
      {summary !== null && (
        <span className="text-[10px] text-[var(--color-content-tertiary)]">{summary}</span>
      )}
      <ChevronRight
        className={`ml-auto size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        aria-hidden
      />
    </button>
  );
}
