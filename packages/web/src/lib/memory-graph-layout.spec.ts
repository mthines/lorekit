import { describe, expect, it } from 'vitest';
import type { MemoryGraphEdge, MemoryGraphNode, MemoryNeighbour } from '@lorekit/schemas/memory';
import {
  EGO_MAX_NEIGHBOURS,
  connectedComponents,
  edgeWidth,
  hubs,
  layoutEgo,
  layoutGraph,
  nodeRadius,
  orphanNodes,
  scopeFamily,
} from './memory-graph-layout';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const neighbour = (n: number, kind: MemoryNeighbour['kind'], weight = 1): MemoryNeighbour => ({
  kind, id: id(n), scope: 'global', key: `k${n}`, weight, last_at: null,
});
const node = (n: number, over: Partial<MemoryGraphNode> = {}): MemoryGraphNode => ({
  id: id(n), scope: 'global', key: `k${n}`, read_count: 0, opened_count: 0, cited_count: 0, degree: 0, orphan: false, ...over,
});
const edge = (a: number, b: number, weight = 1): MemoryGraphEdge => ({ source: id(a), target: id(b), weight, last_at: null });

describe('layoutEgo', () => {
  const size = { width: 400, height: 300 };

  it('puts the focus at the centre and nothing on top of it', () => {
    const l = layoutEgo([neighbour(1, 'co_cited'), neighbour(2, 'co_cited')], size);
    expect(l.nodes[0]).toMatchObject({ neighbour: null, x: 200, y: 150, radius: 0 });
    for (const n of l.nodes.slice(1)) expect(n.radius).toBeGreaterThan(0);
  });

  it('is deterministic — the same input gives the same output', () => {
    const input = [neighbour(3, 'duplicate', 90), neighbour(1, 'co_cited', 4), neighbour(2, 'cites')];
    expect(layoutEgo(input, size)).toEqual(layoutEgo([...input].reverse(), size));
  });

  it('groups kinds contiguously, in the documented order', () => {
    const l = layoutEgo(
      [neighbour(1, 'duplicate'), neighbour(2, 'co_cited'), neighbour(3, 'superseded_by'), neighbour(4, 'co_cited')],
      size,
    );
    expect(l.nodes.slice(1).map((n) => n.neighbour!.kind)).toEqual(['co_cited', 'co_cited', 'superseded_by', 'duplicate']);
    expect(l.kinds).toEqual(['co_cited', 'superseded_by', 'duplicate']);
  });

  it('orders by weight within a kind and thickens the spoke with it', () => {
    const l = layoutEgo([neighbour(1, 'co_cited', 1), neighbour(2, 'co_cited', 5)], size);
    const [a, b] = l.nodes.slice(1);
    expect(a!.neighbour!.id).toBe(id(2));
    expect(a!.spoke).toBeGreaterThan(b!.spoke);
  });

  it('caps the ring and reports how many were left out', () => {
    const many = Array.from({ length: EGO_MAX_NEIGHBOURS + 6 }, (_, i) => neighbour(i + 1, 'co_cited', i + 1));
    const l = layoutEgo(many, size);
    expect(l.nodes).toHaveLength(EGO_MAX_NEIGHBOURS + 1);
    expect(l.hidden).toBe(6);
    // the strongest survive the cap
    expect(l.nodes.slice(1).some((n) => n.neighbour!.weight === EGO_MAX_NEIGHBOURS + 6)).toBe(true);
  });

  it('keeps every node inside the canvas', () => {
    const many = Array.from({ length: 20 }, (_, i) => neighbour(i + 1, 'co_cited'));
    for (const n of layoutEgo(many, size).nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(size.width);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(size.height);
    }
  });

  it('handles an empty neighbourhood', () => {
    const l = layoutEgo([], size);
    expect(l.nodes).toHaveLength(1);
    expect(l.hidden).toBe(0);
    expect(l.kinds).toEqual([]);
  });
});

describe('layoutGraph', () => {
  const opts = { width: 600, height: 400 };
  const nodes = [node(1, { degree: 2 }), node(2, { degree: 2 }), node(3, { degree: 1 }), node(4, { orphan: true, read_count: 3 })];
  const edges = [edge(1, 2, 3), edge(1, 3)];

  it('places every node exactly once, inside the canvas', () => {
    const p = layoutGraph(nodes, edges, opts);
    expect([...p.keys()].sort()).toEqual(nodes.map((n) => n.id).sort());
    for (const { x, y } of p.values()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(opts.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(opts.height);
    }
  });

  it('is deterministic across runs', () => {
    expect([...layoutGraph(nodes, edges, opts)]).toEqual([...layoutGraph(nodes, edges, opts)]);
  });

  it('draws a heavier edge shorter than a lighter one', () => {
    const p = layoutGraph(nodes, edges, opts);
    const d = (a: number, b: number) => Math.hypot(p.get(id(a))!.x - p.get(id(b))!.x, p.get(id(a))!.y - p.get(id(b))!.y);
    expect(d(1, 2)).toBeLessThan(d(1, 3));
  });

  it('parks orphans on the bottom strip, below every connected node', () => {
    const p = layoutGraph(nodes, edges, opts);
    const orphanY = p.get(id(4))!.y;
    for (const n of nodes.filter((x) => !x.orphan)) expect(p.get(n.id)!.y).toBeLessThan(orphanY);
  });

  it('copes with no nodes, and with edges naming nodes that were cut', () => {
    expect(layoutGraph([], [], opts).size).toBe(0);
    expect(layoutGraph([node(1)], [edge(1, 99)], opts).size).toBe(1);
  });
});

describe('sizing', () => {
  it('grows the node radius sub-linearly and caps it', () => {
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(1_000_000)).toBe(14);
  });
  it('scales edge width with weight against the heaviest edge', () => {
    expect(edgeWidth(1, 4)).toBeLessThan(edgeWidth(4, 4));
    expect(edgeWidth(4, 4)).toBe(4);
  });
});

describe('lenses', () => {
  const ns = [node(1, { degree: 3, cited_count: 2 }), node(2, { degree: 3, cited_count: 5 }), node(3, { degree: 1 }), node(4), node(5, { orphan: true, read_count: 9 }), node(6, { orphan: true, read_count: 2 })];
  const es = [edge(1, 2), edge(2, 3), edge(4, 4 + 0)];

  it('ranks hubs by degree, then citations, and leaves orphans out', () => {
    expect(hubs(ns, 2).map((n) => n.id)).toEqual([id(2), id(1)]);
    expect(hubs(ns).every((n) => !n.orphan && n.degree > 0)).toBe(true);
  });

  it('finds connected components largest-first and never counts orphans', () => {
    const comps = connectedComponents(ns, es);
    expect(comps[0]!.map((n) => n.id).sort()).toEqual([id(1), id(2), id(3)]);
    expect(comps.flat().some((n) => n.orphan)).toBe(false);
  });

  it('lists orphans most-read first', () => {
    expect(orphanNodes(ns).map((n) => n.id)).toEqual([id(5), id(6)]);
  });

  it('names a scope family by its first segment', () => {
    expect(scopeFamily('repo::mthines/lorekit')).toBe('repo');
    expect(scopeFamily('global')).toBe('global');
  });
});
