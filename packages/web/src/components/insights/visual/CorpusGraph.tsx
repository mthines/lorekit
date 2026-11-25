'use client';

/**
 * CorpusGraph — the whole co-usage graph as one SVG: a node per lesson, an edge
 * per pair credited in the same run, orphans parked on a strip along the bottom.
 *
 * Presentational. Geometry is `layoutGraph` (pure, deterministic, tested); which
 * nodes are emphasised is the caller's (`highlight`), so one drawing serves the
 * hubs, clusters and orphans lenses. Same interaction contract as every chart
 * here (`useChartCursor` + a portaled `AnchoredTooltip`): mouse click or Enter
 * opens the lesson, a touch tap only shows the readout.
 */

import { useMemo, useRef } from 'react';
import { AnchoredTooltip } from '@/components/ui/AnchoredTooltip';
import { edgeWidth, layoutGraph, nodeRadius, scopeFamily } from '@/lib/memory-graph-layout';
import type { MemoryGraphEdge, MemoryGraphNode } from '@lorekit/schemas/memory';
import { useChartCursor } from './use-chart-cursor';

const WIDTH = 720;
const HEIGHT = 420;

const SCOPE_FILL: Readonly<Record<string, string>> = {
  global: 'var(--color-scope-global)',
  project: 'var(--color-scope-project)',
  repo: 'var(--color-scope-repo)',
  branch: 'var(--color-scope-branch)',
};
const CLUSTER_FILL = ['var(--color-accent)', 'var(--color-info)', 'var(--color-success)', 'var(--color-scope-branch)', 'var(--color-scope-global)'];

export function scopeFill(scope: string): string {
  return SCOPE_FILL[scopeFamily(scope)] ?? 'var(--color-content-tertiary)';
}

export function clusterFill(index: number): string {
  return CLUSTER_FILL[index % CLUSTER_FILL.length]!;
}

export interface CorpusGraphProps {
  nodes: readonly MemoryGraphNode[];
  edges: readonly MemoryGraphEdge[];
  /** Node ids drawn at full strength; everything else is dimmed. `null` = no emphasis. */
  highlight: ReadonlySet<string> | null;
  /** Override a node's fill (the clusters lens colours by component). */
  fillFor?: (node: MemoryGraphNode) => string;
  onOpen: (node: MemoryGraphNode) => void;
  ariaLabel: string;
}

export function CorpusGraph({ nodes, edges, highlight, fillFor, onOpen, ariaLabel }: CorpusGraphProps) {
  const ordered = useMemo(() => [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), [nodes]);
  const positions = useMemo(() => layoutGraph(ordered, edges, { width: WIDTH, height: HEIGHT }), [ordered, edges]);
  const maxWeight = useMemo(() => Math.max(1, ...edges.map((e) => e.weight)), [edges]);
  const cursor = useChartCursor(ordered.length);
  const lastPointer = useRef('mouse');
  const active = cursor.active === null ? null : (ordered[cursor.active] ?? null);
  const dim = (id: string): boolean => highlight !== null && !highlight.has(id);
  const hasOrphans = ordered.some((n) => n.orphan);

  return (
    <div
      ref={cursor.rootRef}
      {...cursor.rootProps}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && active) {
          e.preventDefault();
          onOpen(active);
          return;
        }
        cursor.rootProps.onKeyDown(e);
      }}
      role="group"
      aria-label={`${ariaLabel} Arrow keys move between lessons, Enter opens one.`}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="presentation">
        {hasOrphans && (
          <line
            x1={12}
            x2={WIDTH - 12}
            y1={HEIGHT - 46}
            y2={HEIGHT - 46}
            stroke="var(--color-border-subtle)"
            strokeDasharray="3 4"
          />
        )}
        {edges.map((e) => {
          const a = positions.get(e.source);
          const b = positions.get(e.target);
          if (!a || !b) return null;
          const faded = highlight !== null && !(highlight.has(e.source) && highlight.has(e.target));
          return (
            <line
              key={`${e.source}-${e.target}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--color-content-tertiary)"
              strokeWidth={edgeWidth(e.weight, maxWeight)}
              strokeLinecap="round"
              opacity={faded ? 0.1 : 0.45}
            />
          );
        })}
        {ordered.map((n, i) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const handlers = cursor.itemHandlers(i);
          const r = n.orphan ? 7 : nodeRadius(n.cited_count);
          return (
            <g
              key={n.id}
              ref={cursor.itemRef(i)}
              data-testid="graph-node"
              data-orphan={n.orphan || undefined}
              className="cursor-pointer"
              opacity={dim(n.id) ? 0.25 : 1}
              onPointerDown={(e) => {
                lastPointer.current = e.pointerType;
              }}
              onPointerEnter={handlers.onPointerEnter}
              onPointerLeave={handlers.onPointerLeave}
              onClick={() => {
                if (lastPointer.current === 'mouse') onOpen(n);
                else handlers.onClick();
              }}
            >
              <circle cx={p.x} cy={p.y} r={r + 6} fill="transparent" />
              <circle
                cx={p.x}
                cy={p.y}
                r={cursor.active === i ? r + 2 : r}
                fill={n.orphan ? 'var(--color-bg-elevated)' : (fillFor ? fillFor(n) : scopeFill(n.scope))}
                stroke={n.orphan ? 'var(--color-content-secondary)' : 'var(--color-bg-raised)'}
                strokeWidth={n.orphan ? 2 : 1}
                strokeDasharray={n.orphan ? '3 2' : undefined}
              />
            </g>
          );
        })}
      </svg>

      <AnchoredTooltip anchor={cursor.anchor} open={active !== null} onDismiss={cursor.dismiss} side="top">
        {active && (
          <div className="max-w-64 text-xs">
            <p className="break-all font-mono font-medium text-[var(--color-content-primary)]">{active.key}</p>
            <p className="mt-0.5 text-[var(--color-content-tertiary)]">{active.scope}</p>
            <p className="mt-1 text-[var(--color-content-secondary)]">
              {active.orphan
                ? `Read ${active.read_count}×, never opened, credited or used with another lesson`
                : `Used together with ${active.degree} ${active.degree === 1 ? 'lesson' : 'lessons'} · credited ${active.cited_count}× · opened ${active.opened_count}×`}
            </p>
            <p className="mt-1 text-[var(--color-content-tertiary)]">Click or press Enter to open</p>
          </div>
        )}
      </AnchoredTooltip>
    </div>
  );
}
