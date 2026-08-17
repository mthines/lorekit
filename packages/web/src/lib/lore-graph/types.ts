/**
 * The shape of the Lore Graph — the 3D map of an account's memories.
 *
 * This module is the CONTRACT between three otherwise-independent pieces: the
 * builder that derives a graph from `LessonEntry[]` (`build.ts`), the layout
 * that assigns each node a position, and the WebGL scene that draws them. It
 * carries types only, so all three can be developed, tested and reviewed
 * without any of them importing Three.js.
 *
 * ## Why the graph is flat typed arrays' source, not an object soup
 *
 * The renderer uploads positions and colours to the GPU as `Float32Array`s. A
 * graph modelled as `{ node: { neighbours: Node[] } }` forces a per-frame walk
 * of a pointer graph to rebuild those buffers, which is exactly the work that
 * makes a 5k-node scene stutter. So nodes and edges are ARRAYS with integer
 * indices (`edge.source` / `edge.target` index into `graph.nodes`), and every
 * consumer can build a GPU buffer with one linear pass and no lookups.
 *
 * The ceiling this has to hold up is knowable rather than hypothetical: a
 * free-plan account is capped at **5,000 active memories** (see
 * `docs/limits.md`), so `nodes.length` is bounded by that plus one node per
 * scope. Everything here is sized for that ceiling, not for an unbounded graph.
 */

import type { ScopePrefix } from '@/lib/scope';

/**
 * What a node represents.
 *
 * Deliberately only two kinds. An earlier sketch had a third — a node per label
 * — which reads well on a whiteboard and badly on screen: popular labels become
 * hubs every memory is tethered to, so the layout collapses into a starburst
 * where the label, not the memory, is the subject. Labels are expressed as
 * EDGES between memories instead (see `EdgeKind.label`), which is the relation
 * the user actually asked to see.
 */
export type NodeKind = 'memory' | 'scope';

/**
 * Why two memories are connected.
 *
 * Every edge kind must be derivable from a `LessonEntry` alone — no extra
 * request, no server-side join — because the graph has to stay honest about
 * what it is showing. An edge the user cannot explain by pointing at a field on
 * the memory is a decorative line.
 */
export type EdgeKind =
  /** Memory → the scope node that owns it. The graph's skeleton. */
  | 'scope'
  /** Memory ↔ memory, sharing at least one label. */
  | 'label'
  /** Memory ↔ memory, sharing a `namespace::` key prefix (`aw-lessons::…`). */
  | 'key'
  /** Memory ↔ memory, recorded from the same `origin_repo`. */
  | 'repo';

export interface GraphNode {
  kind: NodeKind;
  /**
   * Stable identity across rebuilds: the memory's `scope::key` natural key, or
   * the scope string for a scope node. The renderer keys selection and hover
   * off this, so a refetch that re-orders the list must not move the selection.
   */
  id: string;
  /** Short human label — the memory's key, or the scope's last segment. */
  label: string;
  /** The scope this node belongs to (a scope node's own scope, for those). */
  scope: string;
  /** Drives the node's colour; the scope palette already exists in `globals.css`. */
  scopeType: ScopePrefix;
  /**
   * Relative visual weight in `[0, 1]`, used for radius. For a memory this
   * follows `seen_count` (a lesson written twelve times is more load-bearing
   * than one written once); for a scope it follows how many memories it holds.
   */
  weight: number;
  /** Labels carried by the memory. Empty for scope nodes. */
  tags: readonly string[];
  /** `updated_at` as epoch milliseconds — the renderer fades stale memories. */
  updatedAt: number;
  /** Set when the memory is archived, so the scene can dim it. */
  archived: boolean;
}

export interface GraphEdge {
  /** Index into {@link LoreGraph.nodes}. */
  source: number;
  /** Index into {@link LoreGraph.nodes}. */
  target: number;
  kind: EdgeKind;
  /** `(0, 1]` — how strongly the two ends attract during layout. */
  strength: number;
}

/** One entry of the "what got left out" report. */
export interface GraphTruncation {
  /** What was capped. */
  of: 'nodes' | 'edges';
  /** How many candidates existed. */
  total: number;
  /** How many survived the cap. */
  kept: number;
}

export interface LoreGraph {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /**
   * Non-empty when a budget clipped the graph.
   *
   * A visualisation that silently draws 2,000 of your 5,000 memories is lying
   * about the shape of your lore, and the shape is the entire point of drawing
   * it. Whatever the builder dropped is reported here so the UI can say so.
   */
  truncated: readonly GraphTruncation[];
}

/** An empty graph — the shape every consumer renders before data arrives. */
export const EMPTY_GRAPH: LoreGraph = { nodes: [], edges: [], truncated: [] };
