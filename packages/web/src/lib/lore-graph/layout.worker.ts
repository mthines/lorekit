/// <reference lib="webworker" />

/**
 * Runs the Lore Graph layout off the main thread.
 *
 * The relaxation is ~11 ms per iteration at the 5,000-memory plan ceiling. On
 * the main thread that is a dropped frame per iteration and an unresponsive
 * page for the length of the pass — the classic "the tab froze while it was
 * thinking" failure. Here it competes with nothing, and the page stays at 60 fps
 * while the graph settles behind it.
 *
 * The body is intentionally thin: it owns scheduling and transfer, and delegates
 * every actual calculation to the pure functions in `layout.ts`, which are
 * tested in Node. A worker is a bad place to keep logic — it cannot be imported
 * by a normal test and every bug in it is debugged at one remove.
 */

import { relaxPositions, seedPositions, LAYOUT_DEFAULTS } from './layout';
import { DEFAULT_REPORT_EVERY, type LayoutProgress, type LayoutRequest } from './worker-protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * The most recent run. A new request while one is in flight abandons the old
 * one at its next chunk boundary rather than racing it — two layouts writing
 * progress for the same canvas would flicker between two answers.
 */
let currentRun = 0;

function report(runId: number, iteration: number, total: number, positions: Float32Array): void {
  // Copy before transferring: the local buffer must survive to keep iterating,
  // and a transferred one is detached at the sender. The copy is 60 KB at the
  // ceiling — far cheaper than the structured clone transferring exists to skip.
  const snapshot = Float32Array.from(positions);
  const message: LayoutProgress = { type: 'progress', runId, iteration, total, positions: snapshot };
  scope.postMessage(message, [snapshot.buffer]);
}

scope.addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  if (request?.type !== 'layout') return;

  const runId = request.runId;
  currentRun = runId;

  const graph = { nodes: request.nodes, edges: request.edges };
  const total = request.options?.iterations ?? LAYOUT_DEFAULTS.iterations;
  const reportEvery = Math.max(1, request.reportEvery ?? DEFAULT_REPORT_EVERY);
  const positions = seedPositions(graph, request.options);

  // Iteration 0 — the analytic seed. Posted before any relaxation so the scene
  // has something correct to draw immediately; the settling is a refinement the
  // user watches, not a wait they sit through.
  report(runId, 0, total, positions);

  let done = 0;
  const step = () => {
    if (currentRun !== runId) return;

    const chunk = Math.min(reportEvery, total - done);
    relaxPositions(graph, positions, { ...request.options, iterations: chunk });
    done += chunk;
    report(runId, done, total, positions);

    // Yield between chunks. The worker has its own thread, but a tight loop in
    // it still blocks its own message queue — including the cancellation
    // message a newly-typed filter is trying to deliver.
    if (done < total) setTimeout(step, 0);
  };

  if (total > 0) setTimeout(step, 0);
});

export {};
