'use client';

/**
 * RecallFlowChart — who recalled lore, through which read tool, from which
 * kind of scope, as a three-column flow (`lib/recall-flow.ts` builds the
 * nodes, `lib/flow-layout.ts` lays them out).
 *
 * Hovering or focusing a node highlights every band touching it and states its
 * figure in a live line under the chart; "View as table" swaps the drawing for
 * the exact rows it was built from — the accessible equivalent a flow chart
 * needs, and the precise numbers a reader may want.
 *
 * ## Labels live in gutters
 *
 * The outer columns' labels sit in a gutter OUTSIDE their nodes (left of the
 * left column, right of the right column), never on top of the bands, where
 * their counts used to disappear into the band colour. The middle column has
 * bands on both sides, so its labels carry a halo in the card's background
 * colour instead.
 *
 * ## Two colour families, one per half
 *
 * Client → tool bands take their CLIENT's colour (warm and mixed hues); tool →
 * scope bands take their TOOL's colour (a blue family no client uses). Sharing
 * one palette across both halves would paint a client and a tool the same hue,
 * inviting exactly the misreading the caption warns against — that a band
 * leaving a tool is the same calls that entered it from that client.
 */

import { useEffect, useMemo, useState } from 'react';
import { Table2, Workflow } from 'lucide-react';
import { track } from '@/lib/analytics/track';
import { layoutFlow } from '@/lib/flow-layout';
import { OTHER, RECALL_FLOW_COLUMNS, UNATTRIBUTED, recallFlow } from '@/lib/recall-flow';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { formatCompact } from './format';

/** Fallback before the first measurement, and the floor below which labels would collide. */
const DEFAULT_WIDTH = 720;
const MIN_WIDTH = 320;
const HEIGHT = 240;
const HEADER_HEIGHT = 20;
const NODE_WIDTH = 10;
const LABEL_GAP = 6;
/** Approximate advance of one 11px character — enough to truncate a label before it leaves its gutter. */
const CHAR_WIDTH = 6.4;

/** Named clients, in node order. All token-derived; none is blue, which is the tools' family. */
const CLIENT_COLORS = [
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-scope-global)',
  'color-mix(in oklab, var(--color-error) 70%, var(--color-scope-global))',
];
/** The four lore-read tools, in node order: shades of one blue, distinct from every client hue. */
const TOOL_COLORS = [
  'var(--color-info)',
  'color-mix(in oklab, var(--color-info) 55%, white)',
  'color-mix(in oklab, var(--color-info) 60%, black)',
  'color-mix(in oklab, var(--color-info) 55%, var(--color-content-tertiary))',
];
const UNATTRIBUTED_COLOR = 'var(--color-content-secondary)';
const OTHER_COLOR = 'var(--color-content-tertiary)';
const SCOPE_NODE_COLOR = 'var(--color-content-secondary)';

/**
 * The chart's own pixel width, tracked with a ResizeObserver.
 *
 * Laid out at the real width rather than scaled through a fixed viewBox: a
 * scaled SVG shrinks its 11px labels to ~5px on a phone, which is the
 * "chart that ignores the canvas" failure. Measuring keeps text at its size.
 *
 * A callback ref (element in state), not a ref object: the measured element
 * unmounts while the table is shown, and an observer attached once on mount
 * would keep watching the detached node.
 */
function useMeasuredWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(MIN_WIDTH, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref: setElement, width };
}

/** Gutter for the outer labels: a sixth of the width, within readable bounds. */
function gutterFor(width: number): number {
  return Math.min(132, Math.max(76, Math.round(width * 0.16)));
}

/** Truncate `label` so `label value` fits in `maxPx`, keeping the value whole. */
function fitLabel(label: string, value: string, maxPx: number): string {
  const maxChars = Math.floor(maxPx / CHAR_WIDTH);
  if (label.length + 1 + value.length <= maxChars) return label;
  return `${label.slice(0, Math.max(1, maxChars - value.length - 2))}…`;
}

/** Colour per node id for one column: named values from `palette` in order, catch-alls neutral. */
function columnColors(ids: readonly string[], palette: readonly string[]): Map<string, string> {
  let next = 0;
  return new Map(
    ids.map((id) => {
      const key = id.slice(id.indexOf(':') + 1);
      if (key === OTHER) return [id, OTHER_COLOR];
      if (key === UNATTRIBUTED) return [id, UNATTRIBUTED_COLOR];
      return [id, palette[next++] ?? OTHER_COLOR];
    }),
  );
}

interface RecallFlowChartProps {
  rows: readonly UsageStatRow[];
  rangeCaption: string;
}

export function RecallFlowChart({ rows, rangeCaption }: RecallFlowChartProps) {
  const flow = useMemo(() => recallFlow(rows), [rows]);
  const { ref: measureRef, width } = useMeasuredWidth();
  const gutter = gutterFor(width);
  const innerWidth = width - 2 * gutter;
  const layout = useMemo(
    () => layoutFlow(flow.nodes, flow.links, { width: innerWidth, height: HEIGHT, nodeWidth: NODE_WIDTH, nodePadding: 12 }),
    [flow, innerWidth],
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);

  if (flow.totalCalls === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-tertiary)]">
        No successful lore reads in {rangeCaption}.
      </p>
    );
  }

  const clientIds = layout.nodes.filter((n) => n.layer === 0).map((n) => n.id);
  const toolIds = layout.nodes.filter((n) => n.layer === 1).map((n) => n.id);
  const nodeColor = new Map([...columnColors(clientIds, CLIENT_COLORS), ...columnColors(toolIds, TOOL_COLORS)]);
  // Every band takes its SOURCE node's colour: a client's on the left, a tool's on the right.
  const bandColor = (source: string) => nodeColor.get(source) ?? OTHER_COLOR;
  const touches = (l: { source: string; target: string }) => focused !== null && (l.source === focused || l.target === focused);
  const focusedNode = layout.nodes.find((n) => n.id === focused) ?? null;
  const middleX = (innerWidth - NODE_WIDTH) / 2;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-content-tertiary)]">
          {flow.totalCalls.toLocaleString('en-US')} successful lore-read calls
        </span>
        <button
          type="button"
          onClick={() => {
            const next = !asTable;
            track({ name: 'insights.recall_flow_view_changed', view: next ? 'table' : 'chart' });
            setAsTable(next);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          {asTable ? <Workflow className="size-3.5" aria-hidden /> : <Table2 className="size-3.5" aria-hidden />}
          {asTable ? 'View as chart' : 'View as table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Lore-read calls by client, tool and scope type, {rangeCaption}</caption>
            <thead className="text-[var(--color-content-tertiary)]">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Who asked</th>
                <th scope="col" className="py-1 pr-3 font-medium">Read tool</th>
                <th scope="col" className="py-1 pr-3 font-medium">Scope type</th>
                <th scope="col" className="py-1 text-right font-medium">Calls</th>
              </tr>
            </thead>
            <tbody className="text-[var(--color-content-secondary)]">
              {flow.rows.map((r) => (
                <tr key={`${r.client}|${r.tool}|${r.scopeType}`} className="border-t border-[var(--color-border-subtle)]">
                  <td className="py-1 pr-3">{r.client}</td>
                  <td className="py-1 pr-3 font-mono">{r.tool}</td>
                  <td className="py-1 pr-3">{r.scopeType}</td>
                  <td className="py-1 text-right tabular-nums">{r.calls.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={measureRef}>
          <svg
            width={width}
            height={HEIGHT + HEADER_HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT + HEADER_HEIGHT}`}
            className="max-w-full overflow-visible"
            // A GROUP, not role="img": an img is a leaf, so the focusable nodes
            // below would be reachable but never announced.
            role="group"
            aria-label={`${flow.totalCalls} lore-read calls in ${rangeCaption}, from ${clientIds.length} client${clientIds.length === 1 ? '' : 's'}. Use View as table for the exact figures.`}
          >
            {/* Column names, each aligned to its node column. */}
            <g
              aria-hidden
              className="fill-[var(--color-content-tertiary)] text-[11px] font-semibold uppercase tracking-wider"
            >
              <text x={gutter + NODE_WIDTH} y={12} textAnchor="end">
                {RECALL_FLOW_COLUMNS[0]}
              </text>
              <text x={gutter + middleX + NODE_WIDTH / 2} y={12} textAnchor="middle">
                {RECALL_FLOW_COLUMNS[1]}
              </text>
              <text x={width - gutter - NODE_WIDTH} y={12} textAnchor="start">
                {RECALL_FLOW_COLUMNS[2]}
              </text>
            </g>

            <g transform={`translate(${gutter}, ${HEADER_HEIGHT})`}>
              <g fill="none" aria-hidden>
                {layout.links.map((l) => (
                  <path
                    key={`${l.source}->${l.target}`}
                    d={l.path}
                    style={{ stroke: bandColor(l.source) }}
                    strokeWidth={Math.max(1, l.width)}
                    strokeOpacity={focused === null ? 0.4 : touches(l) ? 0.8 : 0.08}
                    className="transition-[stroke-opacity] duration-150"
                  />
                ))}
              </g>
              {layout.nodes.map((n) => {
                const value = formatCompact(n.value);
                // Outer columns label into their gutter; the middle one labels over the bands, haloed.
                const side = n.layer === 0 ? 'left' : n.layer === 2 ? 'right' : 'middle';
                const x = side === 'left' ? n.x0 - LABEL_GAP : n.x1 + LABEL_GAP;
                const maxPx = side === 'middle' ? middleX - LABEL_GAP : gutter - LABEL_GAP * 2;
                const label = fitLabel(n.label, value, maxPx);
                return (
                  <g
                    key={n.id}
                    tabIndex={0}
                    role="img"
                    aria-label={`${n.label}: ${n.value.toLocaleString('en-US')} calls`}
                    onPointerEnter={() => setFocused(n.id)}
                    onPointerLeave={() => setFocused((f) => (f === n.id ? null : f))}
                    onFocus={() => setFocused(n.id)}
                    onBlur={() => setFocused((f) => (f === n.id ? null : f))}
                    className="cursor-default outline-none [&:focus-visible>rect]:stroke-[var(--color-accent)]"
                  >
                    <rect
                      x={n.x0}
                      y={n.y0}
                      width={n.x1 - n.x0}
                      height={Math.max(1, n.y1 - n.y0)}
                      rx={2}
                      style={{ fill: n.layer === 2 ? SCOPE_NODE_COLOR : (nodeColor.get(n.id) ?? OTHER_COLOR) }}
                      strokeWidth={2}
                    />
                    <text
                      x={x}
                      y={(n.y0 + n.y1) / 2}
                      dy="0.35em"
                      textAnchor={side === 'left' ? 'end' : 'start'}
                      className="fill-[var(--color-content-secondary)] text-[11px]"
                      {...(side === 'middle'
                        ? { paintOrder: 'stroke', stroke: 'var(--color-bg-raised)', strokeWidth: 4, strokeLinejoin: 'round' as const }
                        : {})}
                    >
                      <tspan className={n.layer === 1 ? 'font-mono' : undefined}>{label}</tspan>
                      <tspan className="fill-[var(--color-content-tertiary)]"> {value}</tspan>
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      )}

      <p className="min-h-4 text-xs text-[var(--color-content-tertiary)]" aria-live="polite">
        {focusedNode && !asTable
          ? `${focusedNode.label}: ${focusedNode.value.toLocaleString('en-US')} of ${flow.totalCalls.toLocaleString('en-US')} lore-read calls`
          : `Calls, ${rangeCaption}. Left bands are coloured by who asked, right bands by read tool — each half is its own pairing, so a band into a tool and a band out of it are not the same calls continuing.`}
      </p>
    </div>
  );
}
