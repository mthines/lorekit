/**
 * Pure geometry and graph analysis for the memory graph.
 *
 * Hand-rolled rather than a graph library, for `flow-layout.ts`'s reason: every
 * chart in the dashboard is SVG over a tested pure layout, and the two graphs
 * here are small and fixed-shape (one lesson's neighbourhood; a capped corpus
 * graph). Geometry lives here; rendering and interaction live in the component.
 *
 * ## Deterministic on purpose
 *
 * Storybook screenshots are pixel baselines. A layout seeded from `Math.random`
 * or the wall clock would repaint differently on every run and fail the
 * visual-regression suite. Everything here is a function of its inputs: initial
 * positions come from input ORDER (callers sort by id), the simulation runs a
 * fixed number of iterations, and results are rounded so float noise cannot
 * differ between machines.
 */

import type { MemoryEdgeKind, MemoryGraphEdge, MemoryGraphNode, MemoryNeighbour } from '@lorekit/schemas/memory';

export interface Point {
  x: number;
  y: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;

// ── Ego graph: one lesson and its neighbours ─────────────────────────────────

/** Kinds in the order their neighbours are placed round the ring, so each kind is one contiguous arc. */
export const EDGE_KIND_ORDER: readonly MemoryEdgeKind[] = [
  'co_cited',
  'cited_by',
  'cites',
  'supersedes',
  'superseded_by',
  'duplicate',
];

/** Human label for an edge kind — shared by the legend, the list and the readout. */
export const EDGE_KIND_LABEL: Readonly<Record<MemoryEdgeKind, string>> = {
  co_cited: 'Used together',
  cited_by: 'Credited by',
  cites: 'Credits',
  supersedes: 'Replaces',
  superseded_by: 'Replaced by',
  duplicate: 'Near-duplicate',
};

/** One-line explanation of an edge kind, for a readout. */
export const EDGE_KIND_HINT: Readonly<Record<MemoryEdgeKind, string>> = {
  co_cited: 'Credited in the same run',
  cited_by: 'A retrospective that credited this lesson',
  cites: 'A lesson this retrospective credited',
  supersedes: 'The older lesson this one replaces',
  superseded_by: 'A newer lesson that replaces this one',
  duplicate: 'Near-identical wording',
};

/** Most neighbours drawn on the ring; the rest are summarised, never silently dropped. */
export const EGO_MAX_NEIGHBOURS = 24;

export interface EgoNode {
  /** The neighbour, or `null` for the focus lesson at the centre. */
  neighbour: MemoryNeighbour | null;
  x: number;
  y: number;
  /** Centre-to-node distance. 0 for the focus. */
  radius: number;
  /** Stroke width (px) of the spoke to the focus; 0 for the focus itself. */
  spoke: number;
}

export interface EgoLayout {
  nodes: EgoNode[];
  /** Neighbours that did not fit on the ring. */
  hidden: number;
  /** The kinds present, in {@link EDGE_KIND_ORDER}, for a legend that lists only what is drawn. */
  kinds: MemoryEdgeKind[];
}

/**
 * Lay a lesson's neighbours on a ring around it.
 *
 * Neighbours are grouped by kind (one contiguous arc per kind) and ordered by
 * weight within it, so the strongest co-usage sits at the start of its arc. A
 * crowded neighbourhood moves to two rings alternately, which keeps adjacent
 * labels from touching without shrinking the nodes.
 */
export function layoutEgo(
  neighbours: readonly MemoryNeighbour[],
  size: { width: number; height: number },
): EgoLayout {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const sorted = [...neighbours].sort((a, b) => {
    const k = EDGE_KIND_ORDER.indexOf(a.kind) - EDGE_KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const shown = sorted.slice(0, EGO_MAX_NEIGHBOURS);
  const maxWeight = Math.max(1, ...shown.map((n) => n.weight));
  const rMax = Math.min(size.width, size.height) / 2 - 28;
  const twoRings = shown.length > 10;
  const inner = twoRings ? rMax * 0.62 : rMax * 0.9;

  const nodes: EgoNode[] = [{ neighbour: null, x: round(cx), y: round(cy), radius: 0, spoke: 0 }];
  shown.forEach((n, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, shown.length);
    const radius = twoRings && i % 2 === 1 ? rMax : inner;
    nodes.push({
      neighbour: n,
      x: round(cx + radius * Math.cos(angle)),
      y: round(cy + radius * Math.sin(angle)),
      radius: round(radius),
      spoke: round(1 + (3 * n.weight) / maxWeight),
    });
  });

  const present = new Set(shown.map((n) => n.kind));
  return {
    nodes,
    hidden: Math.max(0, sorted.length - shown.length),
    kinds: EDGE_KIND_ORDER.filter((k) => present.has(k)),
  };
}

// ── Corpus graph ─────────────────────────────────────────────────────────────

export interface GraphLayoutOptions {
  width: number;
  height: number;
  /** Fixed — the layout is a function of this, never of convergence. */
  iterations?: number;
}

/** Node radius in px from how often the lesson was credited. Sub-linear so one hub does not swallow the canvas. */
export function nodeRadius(citedCount: number): number {
  return round(4 + Math.min(10, Math.sqrt(Math.max(0, citedCount)) * 2));
}

/** Edge stroke width in px from the number of shared runs. */
export function edgeWidth(weight: number, maxWeight: number): number {
  return round(0.75 + (3.25 * weight) / Math.max(1, maxWeight));
}

/**
 * Place a corpus graph with a small, fixed-iteration force simulation.
 *
 * Seeded on a phyllotaxis spiral in INPUT ORDER, then: pairwise repulsion,
 * spring attraction along edges (stronger for heavier edges), and a weak pull to
 * the centre so disconnected components stay on the canvas. Orphans have no
 * edges, so they are parked on a strip along the bottom instead of being thrown
 * to the margins by repulsion — they are a list to act on, not part of the
 * structure.
 */
export function layoutGraph(
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
  opts: GraphLayoutOptions,
): Map<string, Point> {
  const { width, height } = opts;
  const iterations = opts.iterations ?? 220;
  const connected = nodes.filter((n) => !n.orphan);
  const orphans = nodes.filter((n) => n.orphan);
  const stripH = orphans.length > 0 ? 44 : 0;
  const areaH = Math.max(40, height - stripH);
  const cx = width / 2;
  const cy = areaH / 2;
  const pad = 18;

  const pos = connected.map((_, i) => {
    const r = 14 * Math.sqrt(i + 0.5);
    const a = i * 2.399963229728653; // golden angle
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  const index = new Map(connected.map((n, i) => [n.id, i]));
  const links = edges
    .map((e) => ({ s: index.get(e.source), t: index.get(e.target), w: e.weight }))
    .filter((l): l is { s: number; t: number; w: number } => l.s !== undefined && l.t !== undefined);
  const maxW = Math.max(1, ...links.map((l) => l.w));
  const k = Math.sqrt((width * areaH) / Math.max(1, connected.length)) * 0.45;

  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        const dx = pos[i]!.x - pos[j]!.x;
        const dy = pos[i]!.y - pos[j]!.y;
        const d2 = Math.max(1, dx * dx + dy * dy);
        const f = (k * k) / d2;
        disp[i]!.x += dx * f;
        disp[i]!.y += dy * f;
        disp[j]!.x -= dx * f;
        disp[j]!.y -= dy * f;
      }
    }
    // Fruchterman–Reingold attraction, d²/k along the edge, scaled up for a
    // heavier edge so lessons credited together more often sit closer.
    for (const l of links) {
      const dx = pos[l.s]!.x - pos[l.t]!.x;
      const dy = pos[l.s]!.y - pos[l.t]!.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = ((d * d) / k) * (0.5 + l.w / maxW);
      disp[l.s]!.x -= (dx / d) * f;
      disp[l.s]!.y -= (dy / d) * f;
      disp[l.t]!.x += (dx / d) * f;
      disp[l.t]!.y += (dy / d) * f;
    }
    for (let i = 0; i < pos.length; i += 1) {
      disp[i]!.x += (cx - pos[i]!.x) * 0.3;
      disp[i]!.y += (cy - pos[i]!.y) * 0.3;
      const m = Math.max(1, Math.hypot(disp[i]!.x, disp[i]!.y));
      const step = Math.min(m, 12 * cool + 0.5);
      pos[i]!.x = Math.min(width - pad, Math.max(pad, pos[i]!.x + (disp[i]!.x / m) * step));
      pos[i]!.y = Math.min(areaH - pad, Math.max(pad, pos[i]!.y + (disp[i]!.y / m) * step));
    }
  }

  const out = new Map<string, Point>();
  connected.forEach((n, i) => out.set(n.id, { x: round(pos[i]!.x), y: round(pos[i]!.y) }));
  orphans.forEach((n, i) => {
    const slots = Math.max(1, orphans.length);
    out.set(n.id, {
      x: round(pad + ((width - 2 * pad) * (i + 0.5)) / slots),
      y: round(height - stripH / 2),
    });
  });
  return out;
}

// ── Lenses ───────────────────────────────────────────────────────────────────

/** Connected components of the co-usage graph, largest first. Orphans are never members. */
export function connectedComponents(
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
): MemoryGraphNode[][] {
  const live = nodes.filter((n) => !n.orphan);
  const parent = new Map(live.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue;
    const a = find(e.source);
    const b = find(e.target);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groups = new Map<string, MemoryGraphNode[]>();
  for (const n of live) {
    const r = find(n.id);
    const g = groups.get(r);
    if (g) g.push(n);
    else groups.set(r, [n]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || (a[0]!.id < b[0]!.id ? -1 : 1));
}

/** The most-connected lessons — candidates to promote to `global` or a rule. Ties break by id. */
export function hubs(nodes: readonly MemoryGraphNode[], limit = 5): MemoryGraphNode[] {
  return nodes
    .filter((n) => !n.orphan && n.degree > 0)
    .sort((a, b) => b.degree - a.degree || b.cited_count - a.cited_count || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

/** Read but never opened, credited or connected — candidates to archive. Most-read first. */
export function orphanNodes(nodes: readonly MemoryGraphNode[]): MemoryGraphNode[] {
  return nodes
    .filter((n) => n.orphan)
    .sort((a, b) => b.read_count - a.read_count || (a.id < b.id ? -1 : 1));
}

/** Scope families the nodes span, for a colour legend: the first `::`-delimited segment. */
export function scopeFamily(scope: string): string {
  const head = scope.split('::')[0] ?? scope;
  return head === '' ? 'global' : head;
}
