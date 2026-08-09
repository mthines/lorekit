// Was the pertinent lesson actually available to the agent?
//
// This is the question that decides how a failure may be read. An arm-B rep
// that fails means two completely different things depending on the answer:
//
//   INJECTED            the lesson was on screen and the agent still got it
//                       wrong → a UTILIZATION failure. Something about the
//                       lesson, the prompt, or the model is at fault.
//   IN_STORE_NOT_LOADED the lesson was stored but never reached the context →
//                       a RETRIEVAL failure. The store, the scope, the cap or
//                       the ordering is at fault; the lesson's content is not
//                       on trial at all.
//   ABSENT              the lesson is not in the store. That is a HARNESS bug,
//                       not a result — a rep in this state must be discarded,
//                       never averaged in as a failure.
//
// Reporting all three as "arm B failed" would let a seeding regression read as
// evidence that memory does not work, which is the single most expensive
// mistake this harness could make. So the classification is computed for every
// rep and travels with it.
//
// PR4 adds the third axis the plan calls for — whether `memory.search` would
// have returned the lesson on demand — which distinguishes "not injected, but
// reachable if the agent looks" from "unreachable by any means".

export const RETRIEVAL_INJECTED = "injected";
export const RETRIEVAL_IN_STORE_NOT_LOADED = "in-store-not-loaded";
export const RETRIEVAL_ABSENT = "absent";

/**
 * Classify the availability of one lesson to one attempt.
 *
 * @param {object}   args
 * @param {object}   args.injection    the result of `readInjectedLessons`
 * @param {object[]} args.storeEntries what `listAll` read back from the store
 * @param {string}   args.key          the pertinent lesson's key
 * @param {string}   [args.scope]      the scope the lesson was SEEDED at. Callers
 *                                     gather `storeEntries` across every scope in
 *                                     `readOrder`, so matching on `key` alone lets
 *                                     an unrelated same-key entry at another scope
 *                                     read as in-store-not-loaded (a retrieval
 *                                     failure) when the seeded lesson is in fact
 *                                     absent (a harness fault). Pass it whenever
 *                                     the seeded scope is known.
 * @returns {{ state: string, injected: boolean, inStore: boolean,
 *            position: number|null, scope: string|null, injectedCount: number,
 *            harnessFault: boolean }}
 */
export function classifyRetrieval({
  injection,
  storeEntries = [],
  key,
  scope = null,
} = {}) {
  if (!key) throw new TypeError("classifyRetrieval: key is required");
  const lessons = (injection && injection.lessons) || [];

  const hit = lessons.find((l) => l.key === key) || null;
  const stored =
    storeEntries.find(
      (e) => e && e.key === key && (!scope || e.scope === scope),
    ) || null;

  let state = RETRIEVAL_ABSENT;
  if (hit) state = RETRIEVAL_INJECTED;
  else if (stored) state = RETRIEVAL_IN_STORE_NOT_LOADED;

  return {
    state,
    injected: Boolean(hit),
    inStore: Boolean(stored),
    position: hit ? hit.position : null,
    scope: hit ? hit.scope : stored ? stored.scope : null,
    injectedCount: lessons.length,
    // An arm that was supposed to be seeded but has nothing in the store is a
    // broken run, not a negative result.
    harnessFault: state === RETRIEVAL_ABSENT,
  };
}

/**
 * Given a retrieval classification and whether the attempt succeeded, say what
 * a failure may be ATTRIBUTED to. Returns null when the attempt succeeded.
 *
 * PR5's scale/position sweep reports exactly this per cell; it lives here so
 * the sweep and the per-rep report cannot disagree about what a cell means.
 */
export function attributeFailure({ retrieval, success } = {}) {
  if (success) return null;
  if (!retrieval) return "unknown";
  switch (retrieval.state) {
    case RETRIEVAL_INJECTED:
      return "utilization"; // present and ignored — "lost in the middle"
    case RETRIEVAL_IN_STORE_NOT_LOADED:
      return "retrieval"; // fell out of the window / wrong scope / capped
    default:
      return "harness"; // never stored: discard, do not average in
  }
}
