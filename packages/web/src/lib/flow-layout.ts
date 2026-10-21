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
  for (const n of valued) columns[n.layer]?.push(n);

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

  // Resolve both endpoints once, so the placement below never re-looks-up a node.
  const placed = usable.flatMap((link) => {
    const source = laidOut.get(link.source);
    const target = laidOut.get(link.target);
    return source && target ? [{ link, source, target, width: link.value * scale, sy: 0, ty: 0 }] : [];
  });

  // Leave each source ordered by target position, arrive ordered by source position.
  const sourceOffset = new Map<string, number>();
  for (const p of [...placed].sort((a, b) => a.source.y0 - b.source.y0 || a.target.y0 - b.target.y0)) {
    const offset = sourceOffset.get(p.source.id) ?? 0;
    p.sy = p.source.y0 + offset + p.width / 2;
    sourceOffset.set(p.source.id, offset + p.width);
  }
  const targetOffset = new Map<string, number>();
  for (const p of [...placed].sort((a, b) => a.target.y0 - b.target.y0 || a.source.y0 - b.source.y0)) {
    const offset = targetOffset.get(p.target.id) ?? 0;
    p.ty = p.target.y0 + offset + p.width / 2;
    targetOffset.set(p.target.id, offset + p.width);
  }

  const flowLinks: FlowLink[] = placed.map(({ link, source, target, width: w, sy, ty }) => {
    const x0 = source.x1;
    const x1 = target.x0;
    const xm = (x0 + x1) / 2;
    return {
      ...link,
      width: w,
      sy,
      ty,
      path: `M${round(x0)},${round(sy)}C${round(xm)},${round(sy)} ${round(xm)},${round(ty)} ${round(x1)},${round(ty)}`,
    };
  });

  return { nodes: [...laidOut.values()], links: flowLinks };
}

/** Two decimals keep the path string short without visible error. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
