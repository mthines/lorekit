'use client';

/**
 * Lay a Lore Graph out in a Web Worker, streaming positions as they settle.
 *
 * The impure shell over `lib/lore-graph/layout.ts`: this file owns the worker's
 * lifecycle, run cancellation, and the fallback; every calculation lives in the
 * pure module and is tested there.
 *
 * ## What the caller gets
 *
 * `positions` is a `Float32Array` that is REPLACED (never mutated) on each
 * report, so a `useEffect` keyed on it fires exactly when there is something new
 * to upload to the GPU. It is non-null from the first report — the analytic seed
 * — which arrives in the same tick the worker starts, so there is no spinner
 * state to design and no empty canvas to look at.
 *
 * ## Fallback
 *
 * Where `Worker` is unavailable — SSR, a Storybook run, a locked-down browser —
 * the layout runs synchronously on the main thread with a REDUCED iteration
 * budget. Silently degrading to the full budget would freeze the tab for over a
 * second on a large account, which is worse than a slightly looser picture.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph, type LayoutOptions } from '@/lib/lore-graph/layout';
import type { LoreGraph } from '@/lib/lore-graph/types';
import {
  DEFAULT_REPORT_EVERY,
  type LayoutProgress,
  type LayoutRequest,
} from '@/lib/lore-graph/worker-protocol';

/** Iterations the synchronous fallback runs. Enough to fix overlap, cheap enough to block on. */
export const FALLBACK_ITERATIONS = 12;

export interface LoreGraphLayout {
  /** `x, y, z` per node, in `graph.nodes` order. Empty until the first report. */
  positions: Float32Array;
  /** `0` at the seed, `1` when the relaxation has finished. */
  progress: number;
  /** True while the layout is still settling — for a status line, never a blocking spinner. */
  settling: boolean;
}

export function useLoreGraphLayout(graph: LoreGraph, options?: LayoutOptions): LoreGraphLayout {
  const [state, setState] = useState<LoreGraphLayout>({
    positions: new Float32Array(0),
    progress: 0,
    settling: false,
  });

  // The worker only needs kind/id/scope per node — see `LayoutNode`. Deriving
  // it here rather than in the effect keeps the effect's dependency a value
  // that changes exactly when the graph does.
  const request = useMemo(
    () => ({
      nodes: graph.nodes.map((node) => ({ kind: node.kind, id: node.id, scope: node.scope })),
      edges: graph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        strength: edge.strength,
      })),
    }),
    [graph],
  );

  // A ref, not state: it is a correlation id for messages, and bumping it must
  // not re-render anything.
  const runId = useRef(0);

  useEffect(() => {
    if (request.nodes.length === 0) {
      setState({ positions: new Float32Array(0), progress: 1, settling: false });
      return;
    }

    const id = ++runId.current;
    let worker: Worker | null = null;

    /**
     * Lay out on this thread instead.
     *
     * Reached two ways, and the SECOND one is why this is a named function
     * rather than an inline catch block: `new Worker` throwing is the obvious
     * failure, but a worker that constructs fine and then fails to load its
     * module never throws anywhere — it fires an `error` event and simply
     * never posts. With no handler for that, the map sits on "Arranging the
     * memory map" forever, which is the worst of the three outcomes because
     * it looks like it is still working.
     */
    const layoutInline = () => {
      setState({
        positions: layoutGraph({ nodes: request.nodes, edges: request.edges }, {
          ...options,
          iterations: FALLBACK_ITERATIONS,
        }),
        progress: 1,
        settling: false,
      });
    };

    try {
      worker = new Worker(new URL('../lore-graph/layout.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      layoutInline();
      return;
    }

    worker.addEventListener('error', (event) => {
      // Reported, not swallowed: a worker failing to boot is a bundling
      // problem, and a silent inline fallback would hide it behind "the map
      // feels slow on some machines".
      console.error('[lore-graph] layout worker failed, falling back inline', event.message);
      worker?.terminate();
      worker = null;
      layoutInline();
    });

    worker.addEventListener('message', (event: MessageEvent<LayoutProgress>) => {
      const message = event.data;
      // Ignore a straggler from a run this effect already superseded.
      if (message?.type !== 'progress' || message.runId !== id) return;
      const progress = message.total === 0 ? 1 : message.iteration / message.total;
      setState({ positions: message.positions, progress, settling: progress < 1 });
    });

    const payload: LayoutRequest = {
      type: 'layout',
      runId: id,
      nodes: request.nodes,
      edges: request.edges,
      reportEvery: DEFAULT_REPORT_EVERY,
      ...(options ? { options } : {}),
    };
    worker.postMessage(payload);
    setState((previous) => ({ ...previous, settling: true }));

    return () => {
      // Terminate rather than politely cancel: the worker holds nothing the next
      // run needs, and a half-finished layout racing its successor is the one
      // failure mode this whole run-id dance exists to prevent.
      worker?.terminate();
    };
    // `options` is intentionally not a dependency — it is a static configuration
    // object in every caller, and including it would restart the layout on every
    // render for any caller that writes it inline.
  }, [request]);

  return state;
}
