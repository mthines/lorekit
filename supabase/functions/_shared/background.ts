/**
 * The runtime's background-task hook, detected in ONE place.
 *
 * `EdgeRuntime.waitUntil` keeps the isolate alive after the response has been
 * returned, which is how work that the caller cannot act on — an audit row, a
 * usage event, an embedding — stays off the response path. Three modules reached
 * for it and each had grown its own copy of the same six-line feature test; this
 * is that test, once.
 *
 * WHAT IS SHARED IS THE DETECTION, NOT THE POLICY.
 *
 * Every caller must still decide what to do when the hook is ABSENT, and the
 * three existing answers are deliberately different because the data is
 * different. Do not "simplify" them into one:
 *
 *   * `embed-on-write.ts` SKIPS. Awaiting would put provider latency back on
 *     every write, and the backfill re-derives the row later (it selects on
 *     `embedding is null`), so nothing is lost but time.
 *   * `audit.ts` AWAITS. An audit row has no backfill and D1 makes the app layer
 *     solely responsible for writing it, so latency is the thing to give up.
 *   * `usage.ts` DROPS (`void p`). Plan-sizing analytics are best-effort by
 *     construction and must never delay or fail the operation they measure.
 *
 * Returning the host rather than taking a promise is what keeps that choice with
 * the caller: `embed-on-write` needs to know BEFORE it starts building a payload
 * whether the work is worth doing at all.
 *
 * No imports, by construction — `edge-bare-specifier.spec.ts` fails the build on
 * a bare specifier and the edge runtime is given no import map.
 */

export interface WaitUntilHost {
  waitUntil(p: Promise<unknown>): void;
}

/** The runtime's background-task hook, or `null` where it has none. */
export function background(): WaitUntilHost | null {
  const rt = (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime as WaitUntilHost | undefined;
  return rt && typeof rt.waitUntil === 'function' ? rt : null;
}
