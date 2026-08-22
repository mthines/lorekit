// How much of a request's wall-clock time was OUR code, and how much was
// waiting on something else.
//
// This is the profiling question for a Supabase Edge Function, asked with the
// only instrument the runtime gives us. A CPU profiler cannot be attached to a
// managed Deno isolate — there is no host to run an eBPF agent on and no
// userland V8 profiler to sample — and even where one could attach it would
// mostly report "awaiting fetch", because these handlers are I/O-bound. What we
// DO already have is a CLIENT span per outbound call (`createTracedClient`
// opens one for every PostgREST query and RPC). Subtracting the time those
// cover from the root span's duration leaves the part no child span explains:
// scope expansion, payload building, JSON, the runtime itself. That residue is
// what a profile would have gone looking for, and it is the number that moves
// when we regress.
//
// The subtraction is a UNION, never a sum. Handlers issue concurrent queries
// (`Promise.all`), so adding two 40 ms queries that ran side by side claims
// 80 ms of a request that only spent 40 ms waiting — and self time computed
// from that goes NEGATIVE, which reads as "instant" on exactly the requests
// worth looking at. Overlapping intervals are merged so the answer stays "how
// long was at least one call in flight".
//
// Mirrored self-contained into the Deno edge tree
// (supabase/functions/_shared/io-ledger.ts) because the edge runtime cannot
// cross-import this package — the same pattern as limits.ts and created-at.ts.
// Keep the two copies behaviourally identical; the vitest suite here is the
// guard.

/** A closed wall-clock interval during which one outbound call was in flight. */
export interface IoInterval {
  startMs: number;
  endMs: number;
}

/** The split of a request's duration into waiting and working. */
export interface IoAttribution {
  /** Wall-clock ms during which at least one outbound call was in flight. */
  waitMs: number;
  /** Wall-clock ms unexplained by any outbound call — our own code. */
  selfMs: number;
  /** How many outbound calls were recorded (summed, not merged). */
  calls: number;
}

/**
 * Whether an interval can contribute to the merge at all.
 *
 * Non-finite bounds (a `Date.now()` that never landed, an `undefined` coerced
 * to `NaN`) would poison every comparison in the sweep and silently drag the
 * merged total to `NaN`, so they are dropped rather than clamped — there is no
 * honest duration to salvage. A backwards interval is a clock going backwards
 * mid-request, which is real on a virtualised host; it is kept but treated as
 * zero-length, because discarding it would undercount the CALL while dropping
 * it entirely would also lose the fact that a call happened.
 */
function isUsable(i: IoInterval): boolean {
  return Number.isFinite(i.startMs) && Number.isFinite(i.endMs);
}

/**
 * Total wall-clock ms covered by the union of `intervals`.
 *
 * Overlaps count once. Two calls that ran concurrently for the same 40 ms
 * report 40, not 80.
 */
export function mergeBusyMs(intervals: readonly IoInterval[]): number {
  const usable = intervals
    .filter(isUsable)
    // A backwards interval collapses to its own start rather than extending the
    // union leftwards past where the call actually began.
    .map((i) => ({ startMs: i.startMs, endMs: Math.max(i.startMs, i.endMs) }))
    .sort((a, b) => a.startMs - b.startMs);

  let busy = 0;
  // The right edge of the run of overlapping intervals currently being merged.
  // `-Infinity` means "no run open yet" and makes the first iteration take the
  // open-a-new-run branch without a separate first-element special case.
  let runEnd = -Infinity;
  let runStart = 0;

  for (const { startMs, endMs } of usable) {
    if (startMs > runEnd) {
      // Gap: the previous run is complete and can be banked.
      if (runEnd !== -Infinity) busy += runEnd - runStart;
      runStart = startMs;
      runEnd = endMs;
    } else if (endMs > runEnd) {
      // Overlaps the open run and extends past it — stretch, don't bank.
      runEnd = endMs;
    }
    // Otherwise this interval is fully contained in the open run: it adds no
    // wall-clock time and is already accounted for.
  }
  if (runEnd !== -Infinity) busy += runEnd - runStart;

  return busy;
}

/**
 * Split a request's total duration into I/O wait and self time.
 *
 * `selfMs` is clamped at zero. It can legitimately come out slightly negative:
 * a child span's `end()` reads the clock after the parent's total was measured
 * from an earlier `Date.now()`, and ms-resolution timers on a shared host drift
 * by a tick either way. A negative self time is never information — it is
 * always measurement noise around zero — so it reports zero rather than
 * exporting an impossible number that would break any dashboard averaging it.
 */
export function attributeIoTime(
  totalMs: number,
  intervals: readonly IoInterval[],
): IoAttribution {
  const waitMs = mergeBusyMs(intervals);
  const total = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
  return {
    waitMs,
    // Wait can exceed total when a call outlives the span that measured it;
    // that is the same tick-level noise, so it floors at zero too.
    selfMs: Math.max(0, total - waitMs),
    calls: intervals.filter(isUsable).length,
  };
}
