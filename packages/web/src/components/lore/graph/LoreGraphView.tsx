'use client';

/**
 * The Lore Graph as a page surface: the lazy boundary, the legend, the honest
 * captions, and every path where WebGL is not the answer.
 *
 * ## Why this is a separate component from the scene
 *
 * `LoreGraphScene` pulls in Three.js — ~150 KB gzipped before a single node is
 * drawn. The Explorer must not pay that to render a list, so the scene is behind
 * `React.lazy` and only fetched when a reader actually opens the map. Keeping
 * the boundary in its own file is what makes that guarantee reviewable: nothing
 * here imports `three`, so no future edit can accidentally pull it into the
 * eager bundle.
 *
 * ## Accessibility posture
 *
 * A `<canvas>` gives a screen reader "graphic" and nothing more, so this view is
 * never the only way to reach a memory:
 *
 * - It is a SECOND view of the Explorer's list, toggled. The list stays the
 *   keyboard- and screen-reader-complete path, and selecting a node here opens
 *   the same detail sheet a list row does.
 * - The canvas is `aria-hidden`; a polite live region carries `graphSummary`,
 *   so a non-visual reader is told what is on screen and what is selected.
 * - The legend is real text, not colour alone (WCAG 1.4.1): each scope type is
 *   named next to its swatch.
 * - Truncation is stated in the UI, not just in the data. A map that quietly
 *   omits half your lore misrepresents the shape of it, and the shape is the
 *   whole reason to draw it.
 */

import { lazy, Suspense, useMemo, useState } from 'react';
import { Boxes } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SceneBoundary } from './SceneBoundary';
import { useLoreGraphLayout } from '@/lib/hooks/useLoreGraphLayout';
import { buildLoreGraph, type GraphMemoryInput } from '@/lib/lore-graph/build';
import { graphSummary, coverageNotice } from '@/lib/lore-graph/summary';
import type { ScopePrefix } from '@/lib/scope';

const LoreGraphScene = lazy(() => import('./LoreGraphScene'));

export interface LoreGraphViewProps {
  /** The memories currently loaded by the Explorer — the map shows what the list shows. */
  memories: readonly GraphMemoryInput[];
  /**
   * Whether the Explorer's infinite query still has pages to fetch.
   *
   * `memories` is the pages loaded SO FAR, so without this the map would draw a
   * complete-looking picture of a subset. It gates the coverage notice, and the
   * empty state below — an empty first page with more pending is "still
   * loading", not "nothing to map".
   */
  hasMore: boolean;
  /** `scope::key` of the open memory, so the map and the list agree on selection. */
  selectedId: string | null;
  /** Called with a memory's `scope` and `key` when a node is chosen. */
  /**
   * Called with the chosen memory's node id — the canonical `scope::key` from
   * `memoryNodeId`, not the display label.
   *
   * `label` is typed as the SHORT label (a scope node's is its last segment),
   * and it only happens to equal a memory's key today; round-tripping selection
   * through it would turn any future shortening of the label into node clicks
   * that silently no-op.
   */
  onSelect: (nodeId: string) => void;
}

/** Scope types in the order the legend reads them — broadest first. */
const LEGEND: readonly ScopePrefix[] = ['global', 'project', 'repo', 'branch'];

export function LoreGraphView({ memories, hasMore, selectedId, onSelect }: LoreGraphViewProps) {
  const graph = useMemo(() => buildLoreGraph(memories), [memories]);
  const { positions, settling } = useLoreGraphLayout(graph);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const selectedLabel = selectedId ? (nodeById.get(selectedId)?.label ?? null) : null;
  const hovered = hoveredId ? nodeById.get(hoveredId) : undefined;
  const notice = coverageNotice(graph, { hasMore });

  // Still paging: the frame belongs to the loading placeholder, not to an empty
  // state that tells the reader there is nothing here. Same reasoning as the
  // list's `lessons.length === 0 && !hasNextPage` guard, which the map branch in
  // `LoreExplorer` sits above and so never reaches.
  if (memories.length === 0 && hasMore) {
    return (
      <div
        className="h-[60vh] min-h-[380px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
        role="status"
        aria-label="Loading the memory map"
      >
        <SceneSkeleton />
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="Nothing to map yet"
        description="The map draws the memories currently loaded below. Once your agents start writing lore, their scopes and relationships appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Always mounted, contents swapped. A live region inserted into the DOM
          with its text already in it is unreliably announced — several screen
          readers only report changes to a region they were already observing —
          so the empty case keeps the element and drops only the visible box. */}
      <p
        role="status"
        className={
          notice === null
            ? 'sr-only'
            : 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2 text-xs text-[var(--color-content-secondary)]'
        }
      >
        {notice}
      </p>

      {/* The non-visual equivalent of the canvas. Polite, not assertive: the
          map settling is not an interruption worth talking over. */}
      <p role="status" aria-live="polite" className="sr-only">
        {settling ? 'Arranging the memory map' : graphSummary(graph, selectedLabel)}
      </p>

      <div className="relative h-[60vh] min-h-[380px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]">
        {/* The boundary is OUTSIDE Suspense: a scene that throws on its first
            render must not be retried into the same throw by the lazy boundary,
            and the fallback has to survive the chunk having loaded fine. */}
        <SceneBoundary>
          <Suspense fallback={<SceneSkeleton />}>
          <LoreGraphScene
            graph={graph}
            positions={positions}
            selectedId={selectedId}
            onSelect={(nodeId) => {
              const node = nodeById.get(nodeId);
              // Scope nodes are landmarks, not memories — clicking one selects
              // nothing rather than opening a detail sheet for a thing that has
              // no detail.
              if (node?.kind === 'memory') onSelect(node.id);
            }}
            onHover={setHoveredId}
          />
          </Suspense>
        </SceneBoundary>

        {/* The hover read-out lives in the DOM beside the canvas rather than as
            a floating 3D label: no per-frame DOM/scene sync, it stays legible
            at any camera angle, and it cannot end up clipped off-screen. */}
        {hovered && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(28rem,80%)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/95 px-3 py-2">
            <p className="truncate text-sm text-[var(--color-content-primary)]">{hovered.label}</p>
            <p className="truncate text-xs text-[var(--color-content-secondary)]">
              {hovered.kind === 'scope' ? 'Scope' : hovered.scope}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--color-content-secondary)]">
        {LEGEND.map((type) => (
          <span key={type} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full"
              // The token, not `SCOPE_HEX`. That mirror exists because a WebGL
              // instance-colour attribute cannot resolve a CSS variable; this
              // swatch is DOM, where the package rule is tokens only.
              style={{ backgroundColor: `var(--color-scope-${type})` }}
            />
            {type}
          </span>
        ))}
        <span className="ml-auto">Drag to orbit · scroll to zoom · click a memory to open it</span>
      </div>
    </div>
  );
}

/**
 * What fills the frame while the Three.js chunk downloads, or while the first
 * page of memories is still in flight.
 *
 * A shaped placeholder rather than a spinner: the wait is a code-split fetch,
 * which is usually a few hundred milliseconds, and a spinner in that band reads
 * as "broken" rather than "loading" (see the wait-duration ladder in
 * `agent-skills` `animations/rules/perceived-performance.md`).
 */
function SceneSkeleton() {
  return (
    <div
      className="size-full animate-pulse bg-[var(--color-bg-elevated)]"
      role="presentation"
      aria-hidden="true"
    />
  );
}
