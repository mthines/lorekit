'use client';

/**
 * MemoryEgoGraph — one lesson drawn at the centre of its neighbours.
 *
 * Presentational only: the neighbours arrive from `useMemoryNeighbours`, the
 * geometry from `layoutEgo` (pure, tested), and "open this neighbour" is the
 * caller's. Hand-rolled SVG like every other chart here.
 *
 * ## Interaction
 *
 * The graph is the OVERVIEW; the list under it is the accessible, complete way
 * to navigate. A node shows a portaled readout on hover / focus / tap (the
 * shared `useChartCursor` contract: one tab stop, arrows walk the nodes, Escape
 * clears). A mouse click or Enter opens the neighbour; a touch tap only shows
 * the readout, because a fingertip cannot hover and an accidental open would
 * replace the lesson the reader was looking at.
 */

import { useRef } from 'react';
import { AnchoredTooltip } from '@/components/ui/AnchoredTooltip';
import { useChartCursor } from '@/components/insights/visual/use-chart-cursor';
import {
  EDGE_KIND_HINT,
  EDGE_KIND_LABEL,
  layoutEgo,
} from '@/lib/memory-graph-layout';
import type { MemoryEdgeKind, MemoryNeighbour } from '@lorekit/schemas/memory';

const WIDTH = 480;
const HEIGHT = 300;
const LABEL_LIMIT = 10;

/** Stroke per edge kind — colour tokens only, so the graph follows the theme. */
export const EDGE_KIND_STROKE: Readonly<Record<MemoryEdgeKind, string>> = {
  co_cited: 'var(--color-accent)',
  cited_by: 'var(--color-info)',
  cites: 'var(--color-info)',
  supersedes: 'var(--color-scope-branch)',
  superseded_by: 'var(--color-scope-branch)',
  duplicate: 'var(--color-content-tertiary)',
};

/** The last `::` segment, shortened — a ring label has room for about this much. */
export function shortKey(key: string, max = 16): string {
  const tail = key.split('::').pop() ?? key;
  return tail.length > max ? `${tail.slice(0, max - 1)}…` : tail;
}

function describeWeight(n: MemoryNeighbour): string {
  switch (n.kind) {
    case 'co_cited':
      return `${n.weight} shared ${n.weight === 1 ? 'run' : 'runs'}`;
    case 'cited_by':
    case 'cites':
      return `${n.weight} ${n.weight === 1 ? 'citation' : 'citations'}`;
    case 'duplicate':
      return `${n.weight}% similar`;
    default:
      return '';
  }
}

export interface MemoryEgoGraphProps {
  /** The focus lesson's key, drawn at the centre. */
  focusKey: string;
  neighbours: readonly MemoryNeighbour[];
  onOpen: (neighbour: MemoryNeighbour) => void;
}

export function MemoryEgoGraph({ focusKey, neighbours, onOpen }: MemoryEgoGraphProps) {
  const layout = layoutEgo(neighbours, { width: WIDTH, height: HEIGHT });
  const ring = layout.nodes.slice(1);
  const focus = layout.nodes[0]!;
  const cursor = useChartCursor(ring.length);
  const lastPointer = useRef<string>('mouse');
  const labelled = ring.length <= LABEL_LIMIT;
  const active = cursor.active === null ? null : (ring[cursor.active]?.neighbour ?? null);

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
      aria-label={`Connections of ${focusKey}. ${ring.length} ${ring.length === 1 ? 'lesson' : 'lessons'}. Arrow keys move between them, Enter opens one.`}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="presentation">
        {ring.map((n, i) => (
          <line
            key={`spoke-${n.neighbour!.kind}-${n.neighbour!.id}`}
            x1={focus.x}
            y1={focus.y}
            x2={n.x}
            y2={n.y}
            stroke={EDGE_KIND_STROKE[n.neighbour!.kind]}
            strokeWidth={n.spoke}
            strokeDasharray={n.neighbour!.kind === 'duplicate' ? '4 3' : undefined}
            strokeLinecap="round"
            opacity={cursor.active === null || cursor.active === i ? 0.85 : 0.25}
          />
        ))}

        <circle cx={focus.x} cy={focus.y} r={11} fill="var(--color-accent)" />
        <text
          x={focus.x}
          y={focus.y + 26}
          textAnchor="middle"
          className="fill-[var(--color-content-primary)] text-[10px] font-medium"
        >
          {shortKey(focusKey, 22)}
        </text>

        {ring.map((n, i) => {
          const nb = n.neighbour!;
          const handlers = cursor.itemHandlers(i);
          return (
            <g
              key={`node-${nb.kind}-${nb.id}`}
              ref={cursor.itemRef(i)}
              data-testid="ego-node"
              data-kind={nb.kind}
              className="cursor-pointer"
              onPointerDown={(e) => {
                lastPointer.current = e.pointerType;
              }}
              onPointerEnter={handlers.onPointerEnter}
              onPointerLeave={handlers.onPointerLeave}
              onClick={() => {
                if (lastPointer.current === 'mouse') onOpen(nb);
                else handlers.onClick();
              }}
              opacity={cursor.active === null || cursor.active === i ? 1 : 0.45}
            >
              <circle cx={n.x} cy={n.y} r={14} fill="transparent" />
              <circle
                cx={n.x}
                cy={n.y}
                r={cursor.active === i ? 8 : 6}
                fill="var(--color-bg-raised)"
                stroke={EDGE_KIND_STROKE[nb.kind]}
                strokeWidth={2}
              />
              {labelled && (
                <text
                  x={n.x}
                  y={n.y + (n.y < focus.y ? -12 : 20)}
                  textAnchor="middle"
                  className="fill-[var(--color-content-secondary)] text-[9px]"
                >
                  {shortKey(nb.key)}
                </text>
              )}
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
              {EDGE_KIND_LABEL[active.kind]} — {EDGE_KIND_HINT[active.kind]}
              {describeWeight(active) ? ` (${describeWeight(active)})` : ''}
            </p>
            <p className="mt-1 text-[var(--color-content-tertiary)]">Click or press Enter to open</p>
          </div>
        )}
      </AnchoredTooltip>
    </div>
  );
}
