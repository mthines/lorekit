/**
 * A small, pure layered-flow (Sankey) layout: nodes in fixed columns, link
 * bands whose thickness is proportional to their value.
 *
 * ## Why hand-rolled rather than `d3-sankey`
 *
 * The recall flow is three fixed columns (client → tool → scope type) with a
 * handful of nodes each — no cycles, no column assignment to infer, no
 * iterative relaxation worth running. What `d3-sankey` adds over this is
 * exactly the part this chart does not need, and every other chart in the
 * dashboard is hand-rolled SVG over a pure layout (`Sparkbar`,
 * `ContributionHeatmap`), so this keeps the same shape: geometry here, tested;
 * rendering and interaction in the component.
 *
 * ## One scale for the whole chart
 *
 * Every band shares ONE value→pixel scale, picked from the fullest column, so a
 * band is the same thickness at both ends and two bands anywhere on the chart
 * compare by thickness alone. Per-column scales would let a column with less
 * total flow look as full as one with more — the Sankey equivalent of a
 * truncated axis.
 *
 * ## Order is the caller's
 *
 * Nodes are stacked in the order given within their column (the caller sorts,
 * typically by value with "other" last). Bands leave a node ordered by their
 * target's position and arrive ordered by their source's, which is what keeps
 * crossings to the ones the data actually implies.
 */

export interface FlowNodeInput {
  id: string;
  label: string;
  /** 0-based column. */
  layer: number;
}

export interface FlowLinkInput {
  source: string;
  target: string;
  value: number;
}

export interface FlowNode extends FlowNodeInput {
  /** `max(inflow, outflow)` — a pass-through node's flow, a leaf's only side. */
  value: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface FlowLink extends FlowLinkInput {
  /** Band thickness in px. */
  width: number;
  /** Band centre where it leaves its source. */
  sy: number;
  /** Band centre where it reaches its target. */
  ty: number;
  /** SVG path for the band's centre line — stroke it at `width`. */
  path: string;
}

export interface FlowLayout {
  nodes: FlowNode[];
  links: FlowLink[];
}

export interface FlowLayoutOptions {
  width: number;
  height: number;
  nodeWidth?: number;
  nodePadding?: number;
}

/**
 * Lay out `nodes` and `links` in a `width` × `height` box.
 *
 * Total: links with a non-positive value or an unknown endpoint are dropped,
 * nodes left with no flow are dropped, and an input with nothing to draw
 * returns an empty layout rather than NaN geometry.
 */
export function layoutFlow(
  nodes: readonly FlowNodeInput[],
  links: readonly FlowLinkInput[],
  { width, height, nodeWidth = 12, nodePadding = 10 }: FlowLayoutOptions,
): FlowLayout {
  const known = new Set(nodes.map((n) => n.id));
  const usable = links.filter((l) => l.value > 0 && known.has(l.source) && known.has(l.target));

  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const l of usable) {
    outflow.set(l.source, (outflow.get(l.source) ?? 0) + l.value);
    inflow.set(l.target, (inflow.get(l.target) ?? 0) + l.value);
  }

  const valued = nodes
    .map((n) => ({ ...n, value: Math.max(inflow.get(n.id) ?? 0, outflow.get(n.id) ?? 0) }))
    .filter((n) => n.value > 0);
  if (valued.length === 0) return { nodes: [], links: [] };

  const layerCount = Math.max(...valued.map((n) => n.layer)) + 1;
  const columns: (typeof valued)[] = Array.from({ length: layerCount }, () => []);
  for (const n of valued) columns[n.layer]!.push(n);

  // One scale for every column — see the module docblock.
  const scale = Math.min(
    ...columns
      .filter((col) => col.length > 0)
      .map((col) => {
        const total = col.reduce((sum, n) => sum + n.value, 0);
        return Math.max(0, height - nodePadding * (col.length - 1)) / total;
      }),
  );

  const step = layerCount > 1 ? (width - nodeWidth) / (layerCount - 1) : 0;
  const laidOut = new Map<string, FlowNode>();
  columns.forEach((col, layer) => {
    const used = col.reduce((sum, n) => sum + n.value * scale, 0) + nodePadding * Math.max(0, col.length - 1);
    // Centre each column vertically, so a column with less flow than the
    // fullest one sits in the middle rather than hugging the top edge.
    let y = (height - used) / 2;
    const x0 = layer * step;
    for (const n of col) {
      const h = n.value * scale;
      laidOut.set(n.id, { ...n, x0, x1: x0 + nodeWidth, y0: y, y1: y + h });
      y += h + nodePadding;
    }
  });

  const placed = usable.filter((l) => laidOut.has(l.source) && laidOut.has(l.target));
  const sourceOffset = new Map<string, number>();
  const targetOffset = new Map<string, number>();
  const sy = new Map<FlowLinkInput, number>();
  const ty = new Map<FlowLinkInput, number>();

  // Leave each source ordered by target position, arrive ordered by source position.
  const bySourceThenTarget = [...placed].sort(
    (a, b) => laidOut.get(a.source)!.y0 - laidOut.get(b.source)!.y0 || laidOut.get(a.target)!.y0 - laidOut.get(b.target)!.y0,
  );
  for (const l of bySourceThenTarget) {
    const node = laidOut.get(l.source)!;
    const offset = sourceOffset.get(l.source) ?? 0;
    const w = l.value * scale;
    sy.set(l, node.y0 + offset + w / 2);
    sourceOffset.set(l.source, offset + w);
  }
  const byTargetThenSource = [...placed].sort(
    (a, b) => laidOut.get(a.target)!.y0 - laidOut.get(b.target)!.y0 || laidOut.get(a.source)!.y0 - laidOut.get(b.source)!.y0,
  );
  for (const l of byTargetThenSource) {
    const node = laidOut.get(l.target)!;
    const offset = targetOffset.get(l.target) ?? 0;
    const w = l.value * scale;
    ty.set(l, node.y0 + offset + w / 2);
    targetOffset.set(l.target, offset + w);
  }

  const flowLinks: FlowLink[] = placed.map((l) => {
    const x0 = laidOut.get(l.source)!.x1;
    const x1 = laidOut.get(l.target)!.x0;
    const xm = (x0 + x1) / 2;
    const s = sy.get(l)!;
    const t = ty.get(l)!;
    return {
      ...l,
      width: l.value * scale,
      sy: s,
      ty: t,
      path: `M${round(x0)},${round(s)}C${round(xm)},${round(s)} ${round(xm)},${round(t)} ${round(x1)},${round(t)}`,
    };
  });

  return { nodes: [...laidOut.values()], links: flowLinks };
}

/** Two decimals keep the path string short without visible error. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
