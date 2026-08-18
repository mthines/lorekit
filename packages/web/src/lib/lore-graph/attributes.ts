/**
 * Turn a laid-out graph into the typed arrays the GPU consumes.
 *
 * This is the last pure step before WebGL, and it is deliberately a separate
 * module from the scene component: every buffer the renderer uploads is built
 * here by a function that takes plain data and returns a `Float32Array`, so the
 * expensive, easy-to-get-wrong part (per-node colour, per-node radius, the
 * flattened edge endpoint list) is unit-tested in Node without a canvas, a GPU,
 * or a browser test runner.
 *
 * ## Why the buffers look like this
 *
 * - **One `InstancedMesh` for every memory node.** Instancing means node count
 *   costs GPU memory, not draw calls: 5,000 memories is one draw. A `<mesh>` per
 *   node would be 5,000 draws and a dead frame budget.
 * - **One `LineSegments` for every edge.** `LineSegments` reads its position
 *   attribute as independent `(start, end)` pairs, so the whole edge set is a
 *   single buffer and a single draw — which is why {@link edgePositions} emits
 *   six floats per edge rather than an indexed structure.
 * - **Colour is an attribute, not a material.** A material per scope type would
 *   split the instanced draw four ways for no visual gain.
 *
 * Every builder writes into a caller-supplied array when given one. The scene
 * re-uses its buffers across rebuilds, and allocating a fresh 60 KB array per
 * hover would hand the GC exactly the kind of steady churn that shows up as
 * frame-time spikes.
 */

import type { GraphNode, LoreGraph } from './types';
import { dim, scopeRgb, type Rgb } from './palette';

/** How dark an archived memory is drawn, relative to its live siblings. */
export const ARCHIVED_DIM = 0.55;

/** Radius bounds for a memory node, in world units. */
export const MEMORY_RADIUS = { min: 0.35, max: 1.1 } as const;

/** Radius bounds for a scope node — always larger, so landmarks read as landmarks. */
export const SCOPE_RADIUS = { min: 1.6, max: 3.4 } as const;

function sized(node: GraphNode): number {
  const bounds = node.kind === 'scope' ? SCOPE_RADIUS : MEMORY_RADIUS;
  return bounds.min + (bounds.max - bounds.min) * Math.min(Math.max(node.weight, 0), 1);
}

/** Reuse `into` when it is exactly the right size; otherwise allocate. */
function buffer(into: Float32Array | undefined, length: number): Float32Array {
  return into && into.length === length ? into : new Float32Array(length);
}

/**
 * Per-node radius, in `graph.nodes` order.
 *
 * Radius, not scale, because the caller multiplies it into an instance matrix
 * whose base geometry is a unit sphere — keeping the unit meaningful is what
 * lets the camera's framing maths and the hit-test share one number.
 */
export function nodeRadii(graph: LoreGraph, into?: Float32Array): Float32Array {
  const out = buffer(into, graph.nodes.length);
  graph.nodes.forEach((node, index) => {
    out[index] = sized(node);
  });
  return out;
}

/** Per-node `r, g, b`, in `graph.nodes` order. */
export function nodeColors(graph: LoreGraph, into?: Float32Array): Float32Array {
  const out = buffer(into, graph.nodes.length * 3);
  graph.nodes.forEach((node, index) => {
    const colour: Rgb = node.archived ? dim(scopeRgb(node.scopeType), ARCHIVED_DIM) : scopeRgb(node.scopeType);
    out[index * 3] = colour[0];
    out[index * 3 + 1] = colour[1];
    out[index * 3 + 2] = colour[2];
  });
  return out;
}

/**
 * Flattened edge endpoints: six floats per edge, `x1 y1 z1 x2 y2 z2`.
 *
 * The format `THREE.LineSegments` reads directly — every consecutive pair of
 * vertices is one independent segment — so the entire edge set draws in one
 * call regardless of how many edges there are.
 */
export function edgePositions(
  graph: LoreGraph,
  positions: Float32Array,
  into?: Float32Array,
): Float32Array {
  const out = buffer(into, graph.edges.length * 6);
  graph.edges.forEach((edge, index) => {
    const at = index * 6;
    const source = edge.source * 3;
    const target = edge.target * 3;
    out[at] = positions[source];
    out[at + 1] = positions[source + 1];
    out[at + 2] = positions[source + 2];
    out[at + 3] = positions[target];
    out[at + 4] = positions[target + 1];
    out[at + 5] = positions[target + 2];
  });
  return out;
}

/**
 * Per-VERTEX edge opacity, two entries per edge.
 *
 * Two, not one, because a line's attributes are per-vertex: giving both ends the
 * same value is what makes the segment a flat colour rather than a gradient. It
 * is written as an explicit pair here so that a future "fade an edge toward its
 * weaker end" is a one-line change rather than a buffer-layout change.
 *
 * Relation edges are drawn at their strength; the scope skeleton is drawn faint
 * and uniform, because it is scaffolding the eye should read past.
 */
export const SKELETON_OPACITY = 0.12;

export function edgeOpacities(graph: LoreGraph, into?: Float32Array): Float32Array {
  const out = buffer(into, graph.edges.length * 2);
  graph.edges.forEach((edge, index) => {
    const opacity =
      edge.kind === 'scope' ? SKELETON_OPACITY : Math.min(1, Math.max(0.15, edge.strength));
    out[index * 2] = opacity;
    out[index * 2 + 1] = opacity;
  });
  return out;
}

/**
 * The camera distance that frames a sphere of `radius` in a `fov`-degree
 * vertical field of view, with `margin` headroom (1.2 = 20 % padding).
 *
 * Solved rather than guessed, so the graph is correctly framed on the first
 * frame for a two-node account and a five-thousand-node one alike — no
 * "zoom to fit" animation the user has to sit through, and no per-frame
 * bounding-box recompute.
 */
export function framingDistance(radius: number, fov = 50, margin = 1.2): number {
  const halfFov = (fov * Math.PI) / 180 / 2;
  return Math.max((radius * margin) / Math.sin(halfFov), 1);
}

/**
 * Per-VERTEX edge colour, with opacity pre-multiplied into it.
 *
 * The trick that keeps every edge in ONE draw call. A `LineBasicMaterial` has a
 * single scalar `opacity`, so per-edge transparency would normally mean either a
 * material per edge (hundreds of draw calls) or a custom shader (a shader to
 * maintain, for a fade). Against this app's near-black background, additive
 * blending makes a pre-multiplied colour indistinguishable from real per-edge
 * alpha — `colour × opacity` added to `#0d0e11` reads exactly as a fainter line —
 * so the whole edge set stays one `LineSegments` with `vertexColors: true`.
 *
 * The cost of the trick is honest and bounded: it only holds on a dark
 * background, which this dashboard is (`packages/web/CLAUDE.md`: dark-only). On
 * a light theme the edges would have to become a real alpha attribute.
 */
export function edgeColors(graph: LoreGraph, base: Rgb, into?: Float32Array): Float32Array {
  const out = buffer(into, graph.edges.length * 6);
  const opacities = edgeOpacities(graph);
  graph.edges.forEach((_, index) => {
    for (let vertex = 0; vertex < 2; vertex++) {
      // Per VERTEX, not per edge. `edgeOpacities` writes an explicit pair
      // precisely so "fade an edge toward its weaker end" is a one-line change
      // there; reading only the first entry would have made that seam dead the
      // moment it was used. The two entries are equal today, so this is
      // identical output and a live seam instead of a documented one.
      const opacity = opacities[index * 2 + vertex];
      const at = index * 6 + vertex * 3;
      out[at] = base[0] * opacity;
      out[at + 1] = base[1] * opacity;
      out[at + 2] = base[2] * opacity;
    }
  });
  return out;
}
