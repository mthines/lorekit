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
 * The caption carries the one reading rule a flow chart needs: the two halves
 * are separate pairings, so a band into a tool and a band out of it are not the
 * same calls continuing.
 */

import { useEffect, useMemo, useState } from 'react';
import { Table2, Workflow } from 'lucide-react';
import { layoutFlow } from '@/lib/flow-layout';
import { RECALL_FLOW_COLUMNS, recallFlow } from '@/lib/recall-flow';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { formatCompact } from './format';

/** Fallback before the first measurement, and the floor below which labels would collide. */
const DEFAULT_WIDTH = 720;
const MIN_WIDTH = 320;
const HEIGHT = 240;
const NODE_WIDTH = 10;

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

/** ≤ 6 hues (top 5 + "other"), each a theme token; "other" is always the neutral one. */
const CLIENT_COLORS = [
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-info)',
  'var(--color-warning)',
  'var(--color-scope-branch)',
];
const OTHER_COLOR = 'var(--color-content-tertiary)';

interface RecallFlowChartProps {
  rows: readonly UsageStatRow[];
  rangeCaption: string;
}

export function RecallFlowChart({ rows, rangeCaption }: RecallFlowChartProps) {
  const flow = useMemo(() => recallFlow(rows), [rows]);
  const { ref: measureRef, width } = useMeasuredWidth();
  const layout = useMemo(
    () => layoutFlow(flow.nodes, flow.links, { width, height: HEIGHT, nodeWidth: NODE_WIDTH, nodePadding: 12 }),
    [flow, width],
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);

  if (flow.totalCalls === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-tertiary)]">
        No lore was recalled in {rangeCaption}.
      </p>
    );
  }

  // Bands take their client's colour, so a reader can follow one surface across.
  const clientIds = layout.nodes.filter((n) => n.layer === 0).map((n) => n.id);
  const clientColor = new Map(
    clientIds.map((id, i) => [id, id === 'c:other' ? OTHER_COLOR : (CLIENT_COLORS[i] ?? OTHER_COLOR)]),
  );
  // A tool → scope band has no single client, so it takes the neutral colour.
  const bandColor = (source: string) => clientColor.get(source) ?? 'var(--color-border)';
  const touches = (l: { source: string; target: string }) => focused !== null && (l.source === focused || l.target === focused);
  const focusedNode = layout.nodes.find((n) => n.id === focused) ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-content-tertiary)]">
          {flow.totalCalls.toLocaleString('en-US')} lore-read calls
        </span>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
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
        <div ref={measureRef} className="flex flex-col gap-2">
          {/* Column names sit over the three node columns: left, centre, right. */}
          <div className="grid grid-cols-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-content-tertiary)]" aria-hidden>
            {RECALL_FLOW_COLUMNS.map((c, i) => (
              <span key={c} className={i === 0 ? 'text-left' : i === 1 ? 'text-center' : 'text-right'}>
                {c}
              </span>
            ))}
          </div>
          <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            className="max-w-full overflow-visible"
            // A GROUP, not role="img": an img is a leaf, so the focusable nodes
            // below would be reachable but never announced.
            role="group"
            aria-label={`${flow.totalCalls} lore-read calls in ${rangeCaption}, from ${clientIds.length} client${clientIds.length === 1 ? '' : 's'}. Use View as table for the exact figures.`}
          >
            <g fill="none" aria-hidden>
              {layout.links.map((l) => (
                <path
                  key={`${l.source}->${l.target}`}
                  d={l.path}
                  stroke={bandColor(l.source)}
                  strokeWidth={Math.max(1, l.width)}
                  strokeOpacity={focused === null ? 0.35 : touches(l) ? 0.75 : 0.08}
                  className="transition-[stroke-opacity] duration-150"
                />
              ))}
            </g>
            {layout.nodes.map((n) => {
              const labelRight = n.layer < 2;
              const fill = n.layer === 0 ? (clientColor.get(n.id) ?? OTHER_COLOR) : 'var(--color-content-secondary)';
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
                  <rect x={n.x0} y={n.y0} width={n.x1 - n.x0} height={Math.max(1, n.y1 - n.y0)} rx={2} fill={fill} strokeWidth={2} />
                  <text
                    x={labelRight ? n.x1 + 6 : n.x0 - 6}
                    y={(n.y0 + n.y1) / 2}
                    dy="0.35em"
                    textAnchor={labelRight ? 'start' : 'end'}
                    className="fill-[var(--color-content-secondary)] text-[11px]"
                  >
                    <tspan className={n.layer === 1 ? 'font-mono' : undefined}>{n.label}</tspan>
                    <tspan className="fill-[var(--color-content-tertiary)]"> {formatCompact(n.value)}</tspan>
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <p className="min-h-4 text-xs text-[var(--color-content-tertiary)]" aria-live="polite">
        {focusedNode && !asTable
          ? `${focusedNode.label}: ${focusedNode.value.toLocaleString('en-US')} of ${flow.totalCalls.toLocaleString('en-US')} lore-read calls`
          : `Calls, ${rangeCaption}. Each half is its own pairing — a band into a tool and a band out of it are not the same calls continuing.`}
      </p>
    </div>
  );
}
