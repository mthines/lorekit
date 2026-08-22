/**
 * The messages the layout worker speaks.
 *
 * A module of its own, importing nothing from the DOM or from `three`, so both
 * ends of the channel share one definition and the protocol can be exercised in
 * a Node test without standing up a `Worker`.
 *
 * ## Why the worker streams instead of answering once
 *
 * The relaxation costs ~11 ms per iteration at the plan ceiling, so the default
 * 120-iteration pass is over a second. A request/response worker would leave the
 * user looking at nothing for that second, then snap to a finished layout.
 * Instead the worker posts the seeded positions immediately (`progress` at
 * iteration 0) and again every `reportEvery` iterations, so the graph appears at
 * once and visibly settles — the same trick as progressive image decoding, and
 * the reason the view has no loading spinner at all.
 *
 * Position buffers are TRANSFERRED, not copied (`postMessage(msg, [buffer])`).
 * A 5,000-node layout is 60 KB per frame and there would be dozens of frames;
 * transferring hands over ownership with no copy, which is also why the worker
 * allocates a fresh buffer for each report rather than re-sending its own.
 */

import type { GraphEdge } from './types';
import type { LayoutNode, LayoutOptions } from './layout';

/**
 * The minimum a layout needs about the graph.
 *
 * Deliberately NOT the whole `LoreGraph`: node labels, tags and timestamps are
 * the bulk of it by bytes and the layout reads none of them. Sending only what
 * the algorithm uses keeps the structured clone that starts the job small.
 */
export interface LayoutRequest {
  type: 'layout';
  /** Monotonic id, echoed back on every report, so a stale run can be ignored. */
  runId: number;
  /** `kind` / `id` / `scope` per node, in `graph.nodes` order. */
  nodes: readonly LayoutNode[];
  edges: readonly Pick<GraphEdge, 'source' | 'target' | 'strength'>[];
  options?: LayoutOptions;
  /** Post a `progress` message every N iterations. */
  reportEvery?: number;
}

export interface LayoutProgress {
  type: 'progress';
  runId: number;
  /** Iterations completed. `0` is the analytic seed, before any relaxation. */
  iteration: number;
  /** Total iterations this run will do, so a caller can show real progress. */
  total: number;
  /** Transferred, not copied. Owned by the receiver once delivered. */
  positions: Float32Array;
}

export type LayoutWorkerMessage = LayoutProgress;

/** How often the worker reports by default: often enough to look alive, rarely enough to be cheap. */
export const DEFAULT_REPORT_EVERY = 10;
