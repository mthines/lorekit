import { describe, expect, it } from 'vitest';
import { layoutFlow, type FlowNodeInput } from './flow-layout';

const nodes: FlowNodeInput[] = [
  { id: 'a', label: 'a', layer: 0 },
  { id: 'b', label: 'b', layer: 0 },
  { id: 'm', label: 'm', layer: 1 },
  { id: 'x', label: 'x', layer: 2 },
  { id: 'y', label: 'y', layer: 2 },
];

describe('layoutFlow', () => {
  const layout = layoutFlow(
    nodes,
    [
      { source: 'a', target: 'm', value: 30 },
      { source: 'b', target: 'm', value: 10 },
      { source: 'm', target: 'x', value: 25 },
      { source: 'm', target: 'y', value: 15 },
    ],
    { width: 300, height: 100, nodeWidth: 10, nodePadding: 10 },
  );
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  it('gives a pass-through node its conserved flow and places columns across the width', () => {
    expect(byId.get('m')?.value).toBe(40);
    expect(byId.get('a')?.x0).toBe(0);
    expect(byId.get('m')?.x0).toBe(145);
    expect(byId.get('x')?.x1).toBe(300);
  });

  it('uses one scale for every column, picked from the fullest', () => {
    // Columns 0 and 2 each hold 40 across two nodes (one 10px gap) → 90px / 40.
    const scale = 90 / 40;
    expect(byId.get('m')!.y1 - byId.get('m')!.y0).toBeCloseTo(40 * scale);
    expect(byId.get('a')!.y1 - byId.get('a')!.y0).toBeCloseTo(30 * scale);
    for (const link of layout.links) expect(link.width).toBeCloseTo(link.value * scale);
  });

  it('stacks bands inside their nodes without overlap', () => {
    const intoM = layout.links.filter((l) => l.target === 'm').sort((p, q) => p.ty - q.ty);
    const m = byId.get('m')!;
    expect(intoM[0]!.ty - intoM[0]!.width / 2).toBeCloseTo(m.y0);
    expect(intoM[1]!.ty + intoM[1]!.width / 2).toBeCloseTo(m.y1);
  });

  it('drops zero, negative and dangling links, and nodes left without flow', () => {
    const sparse = layoutFlow(
      nodes,
      [
        { source: 'a', target: 'm', value: 5 },
        { source: 'b', target: 'm', value: 0 },
        { source: 'm', target: 'ghost', value: 5 },
      ],
      { width: 100, height: 50 },
    );
    expect(sparse.nodes.map((n) => n.id).sort()).toEqual(['a', 'm']);
    expect(sparse.links).toHaveLength(1);
  });

  it('returns an empty layout when there is nothing to draw', () => {
    expect(layoutFlow(nodes, [], { width: 100, height: 50 })).toEqual({ nodes: [], links: [] });
  });
});
