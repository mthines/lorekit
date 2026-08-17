/**
 * Where each node sits in space.
 *
 * Two stages, and the split is the whole performance story:
 *
 * 1. {@link seedPositions} — an ANALYTIC placement. Scopes go on a Fibonacci
 *    sphere; every memory goes near its scope's centre, in a direction derived
 *    from a hash of its own identity. `O(n)`, allocation-free per node, and it
 *    produces a usable picture on the very first frame.
 * 2. {@link relaxPositions} — a BOUNDED force relaxation that only refines the
 *    seed. Repulsion is resolved through a uniform spatial grid, never all
 *    pairs, and the iteration count is fixed rather than run-to-convergence.
 *
 * ## Why not "just run a force-directed layout"
 *
 * The naive form is `O(n²)` per iteration and needs hundreds of iterations. At
 * the 5,000-memory plan ceiling (`docs/limits.md`) that is 25 million node-pair
 * interactions per iteration — seconds of main-thread work for a picture that
 * is, on top of that, DIFFERENT every visit because it starts from random
 * positions. Seeding analytically fixes both: the layout is stable (the same
 * lore lands in the same place tomorrow, so the view is navigable rather than a
 * fresh abstract painting each time) and the relaxation only has to fix local
 * overlap rather than discover the global structure.
 *
 * ## Why scope nodes are pinned
 *
 * The relaxation moves memories but never scopes. Scopes ARE the map's
 * landmarks — "cluster of scopes" is the thing the user came to see — and a
 * simulation free to drift them turns every refetch into a re-orientation
 * exercise. Pinning them also makes the system trivially stable: each memory is
 * attracted to a fixed anchor, so there is no slow global rotation or collapse
 * for the damping term to fight.
 *
 * ## Data shape
 *
 * Positions are one flat `Float32Array` of `x, y, z` triples, indexed
 * identically to `graph.nodes`. That is the exact layout a Three.js
 * `BufferAttribute` wants, so the array can be transferred out of a Web Worker
 * and handed to the GPU with no copy and no per-node object.
 */

import type { GraphEdge, GraphNode } from './types';

/**
 * Everything the layout reads off a node — and nothing else.
 *
 * A `LoreGraph` satisfies this structurally, so callers pass one directly. The
 * narrower type exists for the worker: labels, tags, weights and timestamps are
 * the bulk of a graph by bytes and the layout reads none of them, so declaring
 * the real input lets the worker channel send a fraction of the payload without
 * anyone having to remember which fields were safe to drop.
 */
export type LayoutNode = Pick<GraphNode, 'kind' | 'id' | 'scope'>;

export interface LayoutInput {
  nodes: readonly LayoutNode[];
  edges: readonly Pick<GraphEdge, 'source' | 'target' | 'strength'>[];
}

export interface LayoutOptions {
  /** Radius of the sphere the scope clusters are arranged on. */
  radius?: number;
  /** Radius of a single scope's cloud, before its member-count scaling. */
  clusterRadius?: number;
  /** Relaxation iterations. Fixed, not run-to-convergence. */
  iterations?: number;
  /** How hard non-adjacent nodes push apart. */
  repulsion?: number;
  /** How hard an edge pulls its ends together, scaled by the edge's strength. */
  attraction?: number;
  /** Velocity retained per iteration; below 1 the system always settles. */
  damping?: number;
  /**
   * Most neighbours any one node repels against per iteration. The bound that
   * keeps a pathologically dense cluster from re-introducing `O(n²)`.
   */
  maxNeighbours?: number;
}

export const LAYOUT_DEFAULTS = {
  radius: 60,
  clusterRadius: 6,
  iterations: 120,
  repulsion: 2.2,
  attraction: 0.08,
  damping: 0.82,
  maxNeighbours: 24,
} satisfies Required<LayoutOptions>;

/**
 * FNV-1a, 32-bit. Chosen because it is four lines, dependency-free, stable
 * across engines, and well-spread for short ASCII keys — the layout's only
 * requirement is that the same memory hashes to the same direction on every
 * machine and every visit.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Two independent `[0, 1)` streams out of one hash, for the two sphere angles. */
function splitHash(hash: number): [number, number] {
  return [(hash & 0xffff) / 0x10000, ((hash >>> 16) & 0xffff) / 0x10000];
}

/**
 * The `i`-th of `count` points on a Fibonacci sphere — the standard
 * even-distribution-without-clumping placement, and the reason scope clusters
 * do not pile up at the poles the way naive `(random θ, random φ)` does.
 */
function fibonacciPoint(i: number, count: number, radius: number): [number, number, number] {
  const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  // The golden angle, the increment that makes successive points maximally
  // out of phase with each other.
  const theta = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(theta) * ringRadius * radius, y * radius, Math.sin(theta) * ringRadius * radius];
}

/**
 * Analytic starting positions.
 *
 * Scope placement is keyed on the SORTED scope list rather than on the order
 * the nodes arrived in, so the arrangement depends on which scopes exist and
 * nothing else — two renders of the same account agree even if the underlying
 * pages came back in a different order.
 *
 * Memory placement is keyed on a hash of the memory's own id rather than on its
 * index within the cluster. Index-based placement (a second Fibonacci sphere
 * per cluster) spreads more evenly, but writing ONE new memory then sends every
 * one of its neighbours somewhere else entirely; hash placement fixes a
 * memory's DIRECTION from its scope's centre for good. Stability wins — the
 * relaxation pass exists precisely to even out the clumping this trades for.
 *
 * The one thing a new memory does move is radial distance: a cluster's cloud
 * grows with its population, so its members drift outward together. That is a
 * uniform breath rather than a reshuffle — the constellation a user learned to
 * recognise is still the same constellation, slightly larger.
 */
export function seedPositions(graph: LayoutInput, options: LayoutOptions = {}): Float32Array {
  const { radius, clusterRadius } = { ...LAYOUT_DEFAULTS, ...options };
  const positions = new Float32Array(graph.nodes.length * 3);

  const scopeNames = graph.nodes
    .filter((node) => node.kind === 'scope')
    .map((node) => node.scope)
    .sort();
  const scopeCentre = new Map<string, [number, number, number]>();
  scopeNames.forEach((scope, i) => {
    scopeCentre.set(scope, fibonacciPoint(i, scopeNames.length, radius));
  });

  // A scope holding 500 memories needs a bigger cloud than one holding 3, but
  // linearly bigger would let it swallow the sphere. Volume grows with the cube
  // of the radius, so the radius grows with the cube root of the population.
  const memberCount = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== 'memory') continue;
    memberCount.set(node.scope, (memberCount.get(node.scope) ?? 0) + 1);
  }

  graph.nodes.forEach((node, index) => {
    const centre = scopeCentre.get(node.scope) ?? [0, 0, 0];
    const at = index * 3;
    if (node.kind === 'scope') {
      positions[at] = centre[0];
      positions[at + 1] = centre[1];
      positions[at + 2] = centre[2];
      return;
    }

    const [u, v] = splitHash(hashString(node.id));
    const spread = clusterRadius * Math.cbrt(memberCount.get(node.scope) ?? 1);
    // `acos(1 - 2u)` is the inverse-CDF that makes points uniform over the
    // sphere's SURFACE; plain `u * π` bunches them at the poles. The cube root
    // does the same job for the radius, filling the volume evenly.
    const phi = Math.acos(1 - 2 * u);
    const theta = 2 * Math.PI * v;
    const r = spread * Math.cbrt(((hashString(node.id + '#r') % 1000) + 1) / 1000);

    positions[at] = centre[0] + r * Math.sin(phi) * Math.cos(theta);
    positions[at + 1] = centre[1] + r * Math.cos(phi);
    positions[at + 2] = centre[2] + r * Math.sin(phi) * Math.sin(theta);
  });

  return positions;
}

/** Bucket every node into a `cell`-sized cubic grid, keyed by integer coords. */
function buildGrid(positions: Float32Array, cell: number): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  const count = positions.length / 3;
  for (let node = 0; node < count; node++) {
    const key = cellKey(
      Math.floor(positions[node * 3] / cell),
      Math.floor(positions[node * 3 + 1] / cell),
      Math.floor(positions[node * 3 + 2] / cell),
    );
    const bucket = grid.get(key);
    if (bucket) bucket.push(node);
    else grid.set(key, [node]);
  }
  return grid;
}

/**
 * Pack three signed cell coordinates into one number key.
 *
 * A string key (`` `${x},${y},${z}` ``) allocates a string per node per
 * iteration — 600,000 short-lived strings for a 5,000-node, 120-iteration run,
 * which is enough garbage to show up as GC pauses mid-layout. The offset keeps
 * negative coordinates in range; the multipliers are prime-ish and far apart so
 * distinct cells within ±2048 cannot collide.
 */
function cellKey(x: number, y: number, z: number): number {
  return (x + 2048) * 16_777_216 + (y + 2048) * 4096 + (z + 2048);
}

/**
 * Refine a seeded layout in place, and return the same array.
 *
 * In place because the caller owns a buffer it intends to transfer to the GPU
 * (or out of a worker); allocating a second one per call would double the
 * traffic for no benefit.
 */
export function relaxPositions(
  graph: LayoutInput,
  positions: Float32Array,
  options: LayoutOptions = {},
): Float32Array {
  const { iterations, repulsion, attraction, damping, clusterRadius, maxNeighbours } = {
    ...LAYOUT_DEFAULTS,
    ...options,
  };
  const count = graph.nodes.length;
  if (count === 0 || iterations <= 0) return positions;

  const velocity = new Float32Array(count * 3);
  // Pinned nodes are anchors, not participants — see the module docblock.
  const pinned = graph.nodes.map((node) => node.kind === 'scope');
  const cell = Math.max(clusterRadius, 1);

  for (let step = 0; step < iterations; step++) {
    const grid = buildGrid(positions, cell);

    // ── Repulsion, grid-local only ─────────────────────────────────────────
    for (let node = 0; node < count; node++) {
      if (pinned[node]) continue;
      const cx = Math.floor(positions[node * 3] / cell);
      const cy = Math.floor(positions[node * 3 + 1] / cell);
      const cz = Math.floor(positions[node * 3 + 2] / cell);
      let considered = 0;

      for (let dx = -1; dx <= 1 && considered < maxNeighbours; dx++) {
        for (let dy = -1; dy <= 1 && considered < maxNeighbours; dy++) {
          for (let dz = -1; dz <= 1 && considered < maxNeighbours; dz++) {
            const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
            if (!bucket) continue;
            for (const other of bucket) {
              if (other === node) continue;
              if (considered++ >= maxNeighbours) break;

              let ox = positions[node * 3] - positions[other * 3];
              let oy = positions[node * 3 + 1] - positions[other * 3 + 1];
              let oz = positions[node * 3 + 2] - positions[other * 3 + 2];
              let distanceSquared = ox * ox + oy * oy + oz * oz;

              if (distanceSquared < 1e-6) {
                // Two nodes exactly on top of each other have no direction to
                // separate along. Nudge deterministically (never randomly, or
                // the layout stops being reproducible) using the index delta.
                ox = ((node % 7) - 3) * 0.01;
                oy = ((node % 5) - 2) * 0.01;
                oz = ((other % 3) - 1) * 0.01;
                distanceSquared = Math.max(ox * ox + oy * oy + oz * oz, 1e-6);
              }

              const push = repulsion / distanceSquared;
              const distance = Math.sqrt(distanceSquared);
              velocity[node * 3] += (ox / distance) * push;
              velocity[node * 3 + 1] += (oy / distance) * push;
              velocity[node * 3 + 2] += (oz / distance) * push;
            }
          }
        }
      }
    }

    // ── Attraction along edges ─────────────────────────────────────────────
    for (const edge of graph.edges) {
      const a = edge.source * 3;
      const b = edge.target * 3;
      const dx = positions[b] - positions[a];
      const dy = positions[b + 1] - positions[a + 1];
      const dz = positions[b + 2] - positions[a + 2];
      const pull = attraction * edge.strength;

      if (!pinned[edge.source]) {
        velocity[a] += dx * pull;
        velocity[a + 1] += dy * pull;
        velocity[a + 2] += dz * pull;
      }
      if (!pinned[edge.target]) {
        velocity[b] -= dx * pull;
        velocity[b + 1] -= dy * pull;
        velocity[b + 2] -= dz * pull;
      }
    }

    // ── Integrate ──────────────────────────────────────────────────────────
    for (let i = 0; i < count * 3; i++) {
      velocity[i] *= damping;
      // Clamp the step so a pair that started nearly coincident cannot launch
      // a node across the scene on the first iteration and leave a visible
      // outlier the camera then has to frame.
      positions[i] += Math.max(-cell, Math.min(cell, velocity[i]));
    }
  }

  return positions;
}

/** Seed then relax — the one call a caller normally wants. */
export function layoutGraph(graph: LayoutInput, options: LayoutOptions = {}): Float32Array {
  return relaxPositions(graph, seedPositions(graph, options), options);
}

/**
 * Distance from the origin to the furthest node — what a camera needs to frame
 * the whole graph without a per-frame bounding-box recompute.
 */
export function boundingRadius(positions: Float32Array): number {
  let maxSquared = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const squared =
      positions[i] * positions[i] +
      positions[i + 1] * positions[i + 1] +
      positions[i + 2] * positions[i + 2];
    if (squared > maxSquared) maxSquared = squared;
  }
  return Math.sqrt(maxSquared);
}
