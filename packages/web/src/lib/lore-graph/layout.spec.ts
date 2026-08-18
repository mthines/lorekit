import { describe, expect, it } from 'vitest';
import { buildLoreGraph, scopeNodeId, type GraphMemoryInput } from './build';
import {
  boundingRadius,
  hashString,
  layoutGraph,
  LAYOUT_DEFAULTS,
  relaxPositions,
  seedPositions,
} from './layout';
import { EMPTY_GRAPH, type LoreGraph } from './types';

function memory(key: string, scope = 'repo::mthines/lorekit', tags: string[] = []): GraphMemoryInput {
  return { key, scope, tags, updated_at: '2026-01-01T00:00:00.000Z' };
}

/** A graph with `perScope` memories in each of the named scopes. */
function graphOf(scopes: readonly string[], perScope: number): LoreGraph {
  return buildLoreGraph(
    scopes.flatMap((scope) => Array.from({ length: perScope }, (_, i) => memory(`m${i}`, scope))),
  );
}

function positionOf(graph: LoreGraph, positions: Float32Array, id: string): [number, number, number] {
  const index = graph.nodes.findIndex((node) => node.id === id);
  return [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The smallest distance between any two MEMORY nodes — the layout's crowding. */
function closestMemoryPair(graph: LoreGraph, positions: Float32Array): number {
  let min = Infinity;
  for (let a = 0; a < graph.nodes.length; a++) {
    if (graph.nodes[a].kind !== 'memory') continue;
    for (let b = a + 1; b < graph.nodes.length; b++) {
      if (graph.nodes[b].kind !== 'memory') continue;
      min = Math.min(
        min,
        distance(
          [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]],
          [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]],
        ),
      );
    }
  }
  return min;
}

/** Mean distance between the two ends of every edge — the layout's tightness. */
function meanEdgeLength(graph: LoreGraph, positions: Float32Array): number {
  if (graph.edges.length === 0) return 0;
  const total = graph.edges.reduce((sum, edge) => {
    const a = [positions[edge.source * 3], positions[edge.source * 3 + 1], positions[edge.source * 3 + 2]];
    const b = [positions[edge.target * 3], positions[edge.target * 3 + 1], positions[edge.target * 3 + 2]];
    return sum + distance(a, b);
  }, 0);
  return total / graph.edges.length;
}

describe('hashString', () => {
  it('is stable for the same input', () => {
    expect(hashString('repo::mthines/lorekit::a')).toBe(hashString('repo::mthines/lorekit::a'));
  });

  it('separates inputs that differ by one character', () => {
    expect(hashString('lesson-a')).not.toBe(hashString('lesson-b'));
  });

  it('is an unsigned 32-bit value, so it can index and modulo safely', () => {
    expect(hashString('anything')).toBeGreaterThanOrEqual(0);
    expect(hashString('anything')).toBeLessThan(2 ** 32);
  });
});

describe('seedPositions', () => {
  it('returns one xyz triple per node', () => {
    const graph = graphOf(['global'], 4);
    expect(seedPositions(graph)).toHaveLength(graph.nodes.length * 3);
  });

  it('is empty for an empty graph', () => {
    expect(seedPositions(EMPTY_GRAPH)).toHaveLength(0);
  });

  it('produces finite coordinates for every node', () => {
    const positions = seedPositions(graphOf(['global', 'repo::a/b', 'branch::x'], 12));
    expect([...positions].every(Number.isFinite)).toBe(true);
  });

  it('places each memory nearer its own scope than any other scope', () => {
    const scopes = ['global', 'repo::a/b', 'repo::c/d', 'branch::feat/x'];
    const graph = graphOf(scopes, 8);
    const positions = seedPositions(graph);
    const centres = scopes.map((scope) => positionOf(graph, positions, scopeNodeId(scope)));

    for (const node of graph.nodes) {
      if (node.kind !== 'memory') continue;
      const at = positionOf(graph, positions, node.id);
      const own = distance(at, centres[scopes.indexOf(node.scope)]);
      const nearest = Math.min(...centres.map((centre) => distance(at, centre)));
      expect(own).toBeCloseTo(nearest, 5);
    }
  });

  it('is stable across visits — the same lore lands in the same place', () => {
    const graph = graphOf(['global', 'repo::a/b'], 6);
    expect([...seedPositions(graph)]).toEqual([...seedPositions(graph)]);
  });

  it('keeps a memory in the same DIRECTION from its scope when a sibling is written', () => {
    // The cluster's cloud grows with its population, so members drift outward
    // together — a uniform breath, not a reshuffle. The bearing is what makes a
    // constellation recognisable, and that must not move.
    const before = buildLoreGraph([memory('a'), memory('b')]);
    const after = buildLoreGraph([memory('a'), memory('b'), memory('c')]);
    const id = before.nodes[0].id;

    const bearing = (graph: LoreGraph) => {
      const positions = seedPositions(graph);
      const at = positionOf(graph, positions, id);
      const centre = positionOf(graph, positions, scopeNodeId('repo::mthines/lorekit'));
      const offset = [at[0] - centre[0], at[1] - centre[1], at[2] - centre[2]];
      const length = Math.hypot(...offset) || 1;
      return offset.map((component) => component / length);
    };

    bearing(after).forEach((component, axis) => {
      expect(component).toBeCloseTo(bearing(before)[axis], 5);
    });
  });

  it('does not depend on the order the memories arrived in', () => {
    const input = [memory('a'), memory('b', 'global'), memory('c')];
    const forward = buildLoreGraph(input);
    const reversed = buildLoreGraph([...input].reverse());

    expect(positionOf(forward, seedPositions(forward), forward.nodes[0].id)).toEqual(
      positionOf(reversed, seedPositions(reversed), forward.nodes[0].id),
    );
  });

  it('gives a populous scope a wider cloud than a sparse one', () => {
    const graph = buildLoreGraph([
      ...Array.from({ length: 200 }, (_, i) => memory(`big${i}`, 'repo::big/one')),
      ...Array.from({ length: 3 }, (_, i) => memory(`small${i}`, 'repo::small/one')),
    ]);
    const positions = seedPositions(graph);

    const spreadOf = (scope: string) => {
      const centre = positionOf(graph, positions, scopeNodeId(scope));
      return Math.max(
        ...graph.nodes
          .filter((node) => node.kind === 'memory' && node.scope === scope)
          .map((node) => distance(positionOf(graph, positions, node.id), centre)),
      );
    };

    expect(spreadOf('repo::big/one')).toBeGreaterThan(spreadOf('repo::small/one'));
  });

  it('keeps every scope cluster inside the configured sphere', () => {
    const graph = graphOf(['global', 'repo::a/b', 'repo::c/d'], 10);
    const positions = seedPositions(graph, { radius: 50, clusterRadius: 4 });
    // The sphere radius plus a cluster's own reach, generously bounded.
    expect(boundingRadius(positions)).toBeLessThan(50 + 4 * Math.cbrt(10) + 1);
  });
});

describe('relaxPositions', () => {
  it('never moves a scope node — the map keeps its landmarks', () => {
    const graph = graphOf(['global', 'repo::a/b'], 20);
    const seeded = seedPositions(graph);
    const anchor = positionOf(graph, seeded, scopeNodeId('global'));

    relaxPositions(graph, seeded);
    expect(positionOf(graph, seeded, scopeNodeId('global'))).toEqual(anchor);
  });

  it('separates memories that the seed piled on top of each other', () => {
    const graph = graphOf(['global'], 30);
    const seeded = seedPositions(graph, { clusterRadius: 0.001 });
    const relaxed = relaxPositions(graph, Float32Array.from(seeded), { iterations: 40 });

    expect(closestMemoryPair(graph, relaxed)).toBeGreaterThan(closestMemoryPair(graph, seeded));
  });

  it('keeps related memories closer than unrelated ones', () => {
    const graph = buildLoreGraph([
      memory('a', 'global', ['pair']),
      memory('b', 'global', ['pair']),
      ...Array.from({ length: 20 }, (_, i) => memory(`n${i}`, 'global')),
    ]);
    const positions = layoutGraph(graph);
    const pairDistance = distance(
      positionOf(graph, positions, 'global::a'),
      positionOf(graph, positions, 'global::b'),
    );
    const unrelated = graph.nodes
      .filter((node) => node.kind === 'memory' && node.label.startsWith('n'))
      .map((node) => distance(positionOf(graph, positions, 'global::a'), positionOf(graph, positions, node.id)));

    expect(pairDistance).toBeLessThan(Math.min(...unrelated));
  });

  it('is deterministic — two runs of the same graph agree exactly', () => {
    const graph = graphOf(['global', 'repo::a/b'], 15);
    expect([...layoutGraph(graph)]).toEqual([...layoutGraph(graph)]);
  });

  it('does not blow up: every coordinate stays finite and bounded', () => {
    const graph = graphOf(['global', 'repo::a/b', 'repo::c/d'], 40);
    const positions = layoutGraph(graph);

    expect([...positions].every(Number.isFinite)).toBe(true);
    // A settling system stays near the sphere it was seeded on; a diverging one
    // would be orders of magnitude out.
    expect(boundingRadius(positions)).toBeLessThan(LAYOUT_DEFAULTS.radius * 3);
  });

  it('separates coincident nodes without randomness', () => {
    const graph = graphOf(['global'], 6);
    const stacked = new Float32Array(graph.nodes.length * 3); // every node at the origin
    const first = relaxPositions(graph, Float32Array.from(stacked), { iterations: 10 });
    const second = relaxPositions(graph, Float32Array.from(stacked), { iterations: 10 });

    expect([...first]).toEqual([...second]);
    // `boundingRadius > 0` alone would pass on a pair that stayed coincident and
    // merely drifted together, which is the exact failure the nudge exists to
    // prevent — so assert the pair actually came APART.
    expect(closestMemoryPair(graph, first)).toBeGreaterThan(1);
  });

  it('separates a coincident pair whose indices agree modulo the nudge periods', () => {
    // The nudge components have periods 7, 5, and 3. Keyed on each end
    // independently, a pair 105 apart (their lcm) received one IDENTICAL push
    // and translated together forever. 120 memories guarantee such a pair.
    const graph = graphOf(['global'], 120);
    const stacked = new Float32Array(graph.nodes.length * 3);

    expect(closestMemoryPair(graph, relaxPositions(graph, stacked, { iterations: 10 }))).toBeGreaterThan(1);
  });

  it('does not launch a coincident pair out of the sphere, at any point in the run', () => {
    // The per-iteration clamp bounds the step, not the velocity: before the
    // repulsion divisor was floored, a coincident pair banked an impulse ~1e3×
    // the clamp and paid it out at the clamp for dozens of iterations, peaking
    // ~238 units out of a radius-60 sphere before damping reeled it back in.
    //
    // Sampling only the FINISHED layout misses that entirely — it had settled
    // to ~16 by iteration 120 — so sample the excursion, not just the endpoint.
    const graph = graphOf(['global'], 6);
    const stacked = new Float32Array(graph.nodes.length * 3);

    for (const iterations of [5, 10, 20, 40, LAYOUT_DEFAULTS.iterations]) {
      const relaxed = relaxPositions(graph, Float32Array.from(stacked), { iterations });
      expect(boundingRadius(relaxed)).toBeLessThan(LAYOUT_DEFAULTS.radius);
    }
  });

  it('tightens the graph rather than loosening it', () => {
    const graph = graphOf(['global', 'repo::a/b'], 25);
    const seeded = seedPositions(graph, { clusterRadius: 14 });
    const before = meanEdgeLength(graph, seeded);
    const after = meanEdgeLength(graph, relaxPositions(graph, seeded));

    expect(after).toBeLessThan(before);
  });

  it('is a no-op when asked for no iterations', () => {
    const graph = graphOf(['global'], 5);
    const seeded = seedPositions(graph);
    expect([...relaxPositions(graph, Float32Array.from(seeded), { iterations: 0 })]).toEqual([...seeded]);
  });

  it('handles an empty graph', () => {
    expect(layoutGraph(EMPTY_GRAPH)).toHaveLength(0);
  });

  it('lays out a plan-ceiling account within a worker-sized budget', () => {
    const graph = buildLoreGraph(
      Array.from({ length: 5_000 }, (_, i) => ({
        key: `bucket-${i % 40}::lesson-${i}`,
        scope: `repo::owner/repo-${i % 25}`,
        tags: [`t${i % 300}`],
        updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 3600)).toISOString(),
      })),
    );

    const started = Date.now();
    const positions = layoutGraph(graph, { iterations: 30 });
    const elapsed = Date.now() - started;

    expect(positions).toHaveLength(graph.nodes.length * 3);
    expect([...positions].every(Number.isFinite)).toBe(true);
    // ~10-15 ms per iteration on a developer machine, so ~300-450 ms for this
    // 30-iteration pass. The budget is 100 ms per iteration: roughly 7× that
    // headroom for a slow shared CI runner, and still tight enough that an
    // accidental all-pairs path — which is ~1000× the work at this size, not
    // 7× — cannot slip through. This is the number `docs/lore-graph.md` cites.
    expect(elapsed).toBeLessThan(30 * 100);
  });
});

describe('boundingRadius', () => {
  it('is zero for no nodes', () => {
    expect(boundingRadius(new Float32Array(0))).toBe(0);
  });

  it('is the distance to the furthest node', () => {
    expect(boundingRadius(Float32Array.from([1, 0, 0, 0, 3, 4]))).toBe(5);
  });
});
