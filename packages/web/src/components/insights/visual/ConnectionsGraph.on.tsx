'use client';

/**
 * Insights "Connections" — the `memory-graph` ON arm.
 *
 * The corpus co-usage graph (`GET /memories/graph`) with three LENSES over the
 * same data, each answering one grooming question:
 *
 *   - **Hubs** — lessons credited together with the most others. Candidates to
 *     promote to `global` or into a rule.
 *   - **Clusters** — groups of lessons that travel together. Candidates to
 *     merge, or to read as one topic.
 *   - **Orphans** — read, yet never opened, credited or used with another
 *     lesson. Candidates to archive.
 *
 * A graph of everything would be a tangle at this size; the lens is what makes
 * it a tool. Every claim is bounded honestly: edges exist only where an agent
 * credited lessons in a run (`cited` on `memory.write`), so a sparse graph says
 * "little was credited", not "little was used" — the caption says so.
 */

import { useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { useMemoryGraph } from '@/lib/queries/memory-graph';
import { connectedComponents, hubs, orphanNodes } from '@/lib/memory-graph-layout';
import type { MemoryGraphNode } from '@lorekit/schemas/memory';
import { CorpusGraph, clusterFill, scopeFill } from './CorpusGraph';
import { useInView } from './use-in-view';

export type Lens = 'hubs' | 'clusters' | 'orphans';

const LENSES: readonly { id: Lens; label: string; hint: string }[] = [
  { id: 'hubs', label: 'Hubs', hint: 'Credited together with the most other lessons — candidates to promote to global or a rule.' },
  { id: 'clusters', label: 'Clusters', hint: 'Lessons that travel together — candidates to merge, or to treat as one topic.' },
  { id: 'orphans', label: 'Orphans', hint: 'Read, but never opened, credited or used with another lesson — candidates to archive.' },
];

export interface ConnectionsGraphProps {
  /** ISO 8601 — only co-usage from this instant on (the page window). */
  since: string;
  rangeCaption: string;
}

function LensList({ nodes, onOpen, extra }: { nodes: readonly MemoryGraphNode[]; onOpen: (n: MemoryGraphNode) => void; extra: (n: MemoryGraphNode) => string }) {
  if (nodes.length === 0) return <p className="text-xs text-[var(--color-content-tertiary)]">Nothing in this lens.</p>;
  return (
    <ul className="flex flex-col">
      {nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => onOpen(n)}
            className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs outline-none hover:bg-[var(--color-bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 self-center rounded-full"
              style={{ background: n.orphan ? 'transparent' : scopeFill(n.scope), border: n.orphan ? '1px dashed var(--color-content-tertiary)' : undefined }}
            />
            <span className="truncate font-mono text-[var(--color-content-primary)]">{n.key}</span>
            <span className="truncate text-[var(--color-content-tertiary)]">{n.scope}</span>
            <span className="ml-auto shrink-0 text-[var(--color-content-secondary)]">{extra(n)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ConnectionsBody({ since, rangeCaption }: ConnectionsGraphProps) {
  const [lens, setLens] = useState<Lens>('hubs');
  const { openLessonById } = useMemorySidebar();
  const query = useMemoryGraph({ scope: null, since });
  const data = query.data;

  const analysis = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const edges = data?.edges ?? [];
    const topHubs = hubs(nodes, 8);
    const components = connectedComponents(nodes, edges).filter((c) => c.length >= 2);
    const orphans = orphanNodes(nodes);
    const componentIndex = new Map<string, number>();
    components.forEach((c, i) => c.forEach((n) => componentIndex.set(n.id, i)));
    return { nodes, edges, topHubs, components, orphans, componentIndex };
  }, [data]);

  const highlight = useMemo<ReadonlySet<string> | null>(() => {
    if (lens === 'hubs') return new Set(analysis.topHubs.map((n) => n.id));
    if (lens === 'orphans') return new Set(analysis.orphans.map((n) => n.id));
    return null;
  }, [lens, analysis]);

  function openNode(n: MemoryGraphNode) {
    openLessonById({ scope: n.scope, key: n.key }, undefined, { surface: 'insights-graph' });
  }

  if (query.isLoading) {
    return <div className="h-64 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" aria-hidden />;
  }
  if (query.isError || !data) {
    return (
      <p role="alert" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-error)]">
        Could not load the connections graph. Please refresh the page to try again.
      </p>
    );
  }
  if (analysis.nodes.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-tertiary)]">
        No lessons were credited together in {rangeCaption}. Connections appear when an agent credits several lessons in one run
        (the <code className="font-mono">cited</code> list on <code className="font-mono">memory.write</code>).
      </p>
    );
  }

  const active = LENSES.find((l) => l.id === lens)!;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <div role="radiogroup" aria-label="Connections lens" className="flex flex-wrap gap-1.5">
        {LENSES.map((l) => {
          const count = l.id === 'hubs' ? analysis.topHubs.length : l.id === 'clusters' ? analysis.components.length : analysis.orphans.length;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={lens === l.id}
              onClick={() => setLens(l.id)}
              className={`rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                lens === l.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-content-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]'
              }`}
            >
              {l.label} <span className="text-[var(--color-content-tertiary)]">{count}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-[var(--color-content-tertiary)]">{active.hint}</p>

      <CorpusGraph
        nodes={analysis.nodes}
        edges={analysis.edges}
        highlight={highlight}
        fillFor={lens === 'clusters' ? (n) => (analysis.componentIndex.has(n.id) ? clusterFill(analysis.componentIndex.get(n.id)!) : scopeFill(n.scope)) : undefined}
        onOpen={openNode}
        ariaLabel={`Co-usage graph of ${analysis.nodes.length} lessons, ${analysis.edges.length} connections, ${active.label} lens.`}
      />

      {lens === 'hubs' && <LensList nodes={analysis.topHubs} onOpen={openNode} extra={(n) => `${n.degree} ${n.degree === 1 ? 'link' : 'links'} · credited ${n.cited_count}×`} />}
      {lens === 'orphans' && <LensList nodes={analysis.orphans} onOpen={openNode} extra={(n) => `read ${n.read_count}×`} />}
      {lens === 'clusters' &&
        (analysis.components.length === 0 ? (
          <p className="text-xs text-[var(--color-content-tertiary)]">No group of two or more lessons travelled together.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {analysis.components.slice(0, 6).map((c, i) => (
              <li key={c[0]!.id} className="text-xs">
                <p className="flex items-center gap-1.5 font-medium text-[var(--color-content-secondary)]">
                  <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: clusterFill(i) }} />
                  {c.length} lessons
                </p>
                <LensList nodes={c.slice(0, 4)} onOpen={openNode} extra={(n) => `${n.degree} ${n.degree === 1 ? 'link' : 'links'}`} />
                {c.length > 4 && <p className="px-1.5 text-[var(--color-content-tertiary)]">and {c.length - 4} more</p>}
              </li>
            ))}
          </ul>
        ))}

      <p className="text-[11px] text-[var(--color-content-tertiary)]">
        {analysis.nodes.length} lessons, {analysis.edges.length} connections in {rangeCaption}
        {data.truncated ? ' — showing the most connected; narrow the range to see the rest' : ''}. Connections come from lessons an agent
        credited in the same run, so a quiet graph means little was credited, not little was used.
      </p>
    </div>
  );
}

/**
 * The whole Connections section — heading and body — so the OFF arm can render
 * nothing without leaving a titled, empty section behind. The body mounts only
 * once the placeholder is near the viewport (`use-in-view.ts`): it is a
 * self-join over the citation ledger, so it must not fire on every page load or
 * range switch alongside the page's other aggregates.
 */
export function ConnectionsGraphOn(props: ConnectionsGraphProps) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section id="connections" aria-label="Connections" className="flex scroll-mt-6 flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-content-primary)]">
          <Network className="size-4 text-[var(--color-content-tertiary)]" aria-hidden />
          Connections
        </h2>
        <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">
          Which lessons were credited together in the same run, in {props.rangeCaption}. Find hubs worth promoting, clusters worth
          merging and orphans worth archiving. Pick a lesson to open it.
        </p>
      </div>
      {inView ? (
        <ConnectionsBody {...props} />
      ) : (
        <div ref={ref} className="h-64 rounded-xl border border-dashed border-[var(--color-border)]" aria-hidden />
      )}
    </section>
  );
}
