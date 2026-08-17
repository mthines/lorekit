import { describe, expect, it } from 'vitest';
import { buildLoreGraph, type GraphMemoryInput } from './build';
import {
  ARCHIVED_DIM,
  edgeOpacities,
  edgePositions,
  framingDistance,
  MEMORY_RADIUS,
  nodeColors,
  nodeRadii,
  SCOPE_RADIUS,
  SKELETON_OPACITY,
} from './attributes';
import { dim, scopeRgb } from './palette';
import { seedPositions } from './layout';
import { EMPTY_GRAPH } from './types';

/**
 * Float32 rounding tolerance. Every buffer these builders return is a
 * `Float32Array`, so a value read back out is the nearest 32-bit float to the
 * double that went in — never the double itself.
 */
const F32 = 1e-6;

/** Compare a colour read out of a Float32 buffer to the exact triple it was built from. */
function expectRgb(actual: readonly number[], expected: readonly number[]): void {
  actual.forEach((channel, i) => expect(channel).toBeCloseTo(expected[i], 6));
}

function memory(overrides: Partial<GraphMemoryInput> & Pick<GraphMemoryInput, 'key'>): GraphMemoryInput {
  return { scope: 'repo::mthines/lorekit', updated_at: '2026-01-01T00:00:00.000Z', tags: [], ...overrides };
}

describe('nodeRadii', () => {
  it('emits one radius per node', () => {
    const graph = buildLoreGraph([memory({ key: 'a' }), memory({ key: 'b' })]);
    expect(nodeRadii(graph)).toHaveLength(graph.nodes.length);
  });

  it('draws every scope larger than every memory, so landmarks read as landmarks', () => {
    const graph = buildLoreGraph([memory({ key: 'a', seen_count: 40 }), memory({ key: 'b' })]);
    const radii = nodeRadii(graph);
    const largestMemory = Math.max(
      ...graph.nodes.map((node, i) => (node.kind === 'memory' ? radii[i] : 0)),
    );
    const smallestScope = Math.min(
      ...graph.nodes.map((node, i) => (node.kind === 'scope' ? radii[i] : Infinity)),
    );

    // Float32Array rounds, so compare with a tolerance rather than exactly.
    expect(largestMemory).toBeLessThanOrEqual(MEMORY_RADIUS.max + F32);
    expect(smallestScope).toBeGreaterThanOrEqual(SCOPE_RADIUS.min - F32);
    expect(largestMemory).toBeLessThan(smallestScope);
  });

  it('grows a recurring lesson', () => {
    const graph = buildLoreGraph([memory({ key: 'often', seen_count: 30 }), memory({ key: 'once' })]);
    const radii = nodeRadii(graph);
    const at = (label: string) => radii[graph.nodes.findIndex((n) => n.label === label)];

    expect(at('often')).toBeGreaterThan(at('once'));
  });

  it('reuses a correctly-sized buffer instead of allocating', () => {
    const graph = buildLoreGraph([memory({ key: 'a' })]);
    const reused = new Float32Array(graph.nodes.length);
    expect(nodeRadii(graph, reused)).toBe(reused);
  });

  it('allocates when the supplied buffer is the wrong size', () => {
    const graph = buildLoreGraph([memory({ key: 'a' })]);
    const wrong = new Float32Array(1);
    expect(nodeRadii(graph, wrong)).not.toBe(wrong);
  });
});

describe('nodeColors', () => {
  it('emits r, g, b per node', () => {
    const graph = buildLoreGraph([memory({ key: 'a' })]);
    expect(nodeColors(graph)).toHaveLength(graph.nodes.length * 3);
  });

  it('colours a node by its scope type', () => {
    const graph = buildLoreGraph([memory({ key: 'a', scope: 'branch::feat/x' })]);
    const colours = nodeColors(graph);
    expectRgb([colours[0], colours[1], colours[2]], scopeRgb('branch'));
  });

  it('dims an archived memory without changing its hue', () => {
    const graph = buildLoreGraph([memory({ key: 'a', archived_at: '2026-02-01T00:00:00.000Z' })]);
    const colours = nodeColors(graph);
    expectRgb([colours[0], colours[1], colours[2]], dim(scopeRgb('repo'), ARCHIVED_DIM));
  });
});

describe('edgePositions', () => {
  it('emits six floats per edge — the pair layout LineSegments reads', () => {
    const graph = buildLoreGraph([memory({ key: 'a' }), memory({ key: 'b' })]);
    expect(edgePositions(graph, seedPositions(graph))).toHaveLength(graph.edges.length * 6);
  });

  it('writes the source point then the target point', () => {
    const graph = buildLoreGraph([memory({ key: 'a' })]);
    const positions = seedPositions(graph);
    const flat = edgePositions(graph, positions);
    const edge = graph.edges[0];

    expect([flat[0], flat[1], flat[2]]).toEqual([
      positions[edge.source * 3],
      positions[edge.source * 3 + 1],
      positions[edge.source * 3 + 2],
    ]);
    expect([flat[3], flat[4], flat[5]]).toEqual([
      positions[edge.target * 3],
      positions[edge.target * 3 + 1],
      positions[edge.target * 3 + 2],
    ]);
  });

  it('is empty for an empty graph', () => {
    expect(edgePositions(EMPTY_GRAPH, new Float32Array(0))).toHaveLength(0);
  });
});

describe('edgeOpacities', () => {
  it('emits one value per vertex, not per edge — a line attribute is per-vertex', () => {
    const graph = buildLoreGraph([memory({ key: 'a', tags: ['x'] }), memory({ key: 'b', tags: ['x'] })]);
    expect(edgeOpacities(graph)).toHaveLength(graph.edges.length * 2);
  });

  it('gives both ends of a segment the same value, so it reads flat', () => {
    const graph = buildLoreGraph([memory({ key: 'a' })]);
    const opacities = edgeOpacities(graph);
    expect(opacities[0]).toBe(opacities[1]);
  });

  it('draws the scope skeleton faint and relations at their strength', () => {
    const graph = buildLoreGraph([memory({ key: 'a', tags: ['x'] }), memory({ key: 'b', tags: ['x'] })]);
    const opacities = edgeOpacities(graph);
    const forKind = (kind: string) =>
      graph.edges.map((edge, i) => (edge.kind === kind ? opacities[i * 2] : null)).filter((v) => v !== null);

    forKind('scope').forEach((value) => expect(value).toBeCloseTo(SKELETON_OPACITY, 6));
    expect(Math.min(...(forKind('label') as number[]))).toBeGreaterThan(SKELETON_OPACITY);
  });

  it('keeps a weak relation visible rather than invisible', () => {
    const graph = buildLoreGraph([
      memory({ key: 'a', tags: ['x', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'y'] }),
      memory({ key: 'b', tags: ['x', 'l', 'm', 'n', 'o', 'c', 'd', 'e', 'f', 'g'] }),
    ]);
    const opacities = edgeOpacities(graph);
    const label = graph.edges.findIndex((edge) => edge.kind === 'label');

    expect(graph.edges[label].strength).toBeLessThan(0.15);
    expect(opacities[label * 2]).toBeCloseTo(0.15, 6);
  });
});

describe('framingDistance', () => {
  it('backs the camera off far enough to contain the sphere', () => {
    const radius = 60;
    const distance = framingDistance(radius, 50, 1.2);
    // Half the vertical extent visible at that distance must exceed the radius.
    const halfVisible = distance * Math.tan(((50 * Math.PI) / 180) / 2);
    expect(halfVisible).toBeGreaterThan(radius);
  });

  it('scales with the graph, so a two-node account is framed as well as a huge one', () => {
    expect(framingDistance(120)).toBeCloseTo(framingDistance(60) * 2, 5);
  });

  it('never returns a degenerate distance for an empty graph', () => {
    expect(framingDistance(0)).toBe(1);
  });

  it('adds the requested margin', () => {
    expect(framingDistance(60, 50, 1.5)).toBeGreaterThan(framingDistance(60, 50, 1));
  });
});
