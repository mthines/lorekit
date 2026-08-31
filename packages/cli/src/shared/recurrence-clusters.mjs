// Recurrence clusters — the named classes of repeated failure that the
// Surface-Partner Map's entries instantiate.
//
// This module formalizes something the map already did informally. Before it,
// `obligations-map.mjs` held two bare string constants —
// `COPIES_A_CLAIM_LESSON` and `SIBLING_SET_LESSON` — whose own comments called
// them "the flagship recurrence class" and "the registered-everywhere /
// sibling-set recurrence class". Eight entries, two classes: the clustering had
// been done by hand and encoded as a variable name.
//
// Naming it makes three things possible that a bare constant does not:
//
//   1. A cluster can carry WHY it recurs and WHAT ITS SHAPE IS, not just which
//      lesson key to cite. That text is what a human hitting the check needs.
//   2. `checkObligations` can report the cluster alongside the entry, so two
//      unmet obligations from the same root cause read as one problem.
//   3. It is the join point for the compile pipeline: a cluster is what a
//      candidates scan over the memory store produces (N near-duplicate
//      memories that are really one class), and an invariant entry is what a
//      human writes from a cluster. The `sourceKeys` field records that origin
//      in the only direction currently available — from the entry back to the
//      memories.
//
// Pure and zero-dep by design, like `obligations-pure.mjs`: no filesystem, no
// cwd, no network. The registry is data.
//
// Cluster schema:
//   {
//     id: string,          // stable slug, referenced by map entries' `cluster`
//     name: string,        // one line, the shape of the recurrence
//     lessonKey: string,   // canonical memory key an entry in this class cites
//     why: string,         // why this class recurs — shown on a hit
//     sourceKeys?: string[] // other memory keys this class subsumes, if known
//   }

/**
 * The named recurrence classes. Adding one is a deliberate act: a cluster
 * asserts that several distinct memories are really one class, which is the
 * claim a groom-merge would act on. Two entries sharing a `lessonKey` but not
 * a cluster is a smell — they are the same class and should say so.
 */
export const RECURRENCE_CLUSTERS = [
  {
    id: 'copies-a-claim',
    name: 'A partner copies a claim and goes stale when the source changes',
    lessonKey:
      'implement-suggestion-lessons::a-mechanism-clause-you-correct-in-the-pr-body-must-be-corrected-in-every-doc-that-copies-it',
    why: 'Some surface — a mirrored module, a generated artifact, a doc paragraph — restates a claim it does not own. Changing the origin does not change the copy, and nothing in the edit itself points at the copy.',
  },
  {
    id: 'sibling-set',
    name: 'A set-enumerating surface gains a hole when a member is added or moved',
    lessonKey: 'aw-lessons::docs-drift-grep-must-search-names-not-invocation',
    why: 'Several surfaces enumerate a set (every command, every docs page, every mirrored file). Adding or moving a member leaves each enumeration silently incomplete, and a grep for the invocation rather than the name misses them.',
  },
];

const BY_ID = new Map(RECURRENCE_CLUSTERS.map((cl) => [cl.id, cl]));
const BY_LESSON_KEY = new Map(RECURRENCE_CLUSTERS.map((cl) => [cl.lessonKey, cl]));

/** The cluster with this id, or null. Total: an unknown id is not an error. */
export function clusterById(id) {
  if (typeof id !== 'string' || !id) return null;
  return BY_ID.get(id) ?? null;
}

/**
 * The cluster that owns this lesson key, or null. Lets an entry that still
 * carries a bare `lessonKey` (rather than a `cluster` id) resolve to its class,
 * so the two forms coexist during the migration.
 */
export function clusterForLessonKey(lessonKey) {
  if (typeof lessonKey !== 'string' || !lessonKey) return null;
  return BY_LESSON_KEY.get(lessonKey) ?? null;
}

/**
 * Resolve an entry's cluster from either form — an explicit `cluster` id wins,
 * a bare `lessonKey` falls back to reverse lookup. Returns null when the entry
 * belongs to no known class, which is legal but worth reporting: an entry with
 * no cluster is a one-off, and a one-off is weak evidence for a check.
 */
export function clusterForEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return clusterById(entry.cluster) ?? clusterForLessonKey(entry.lessonKey);
}

/**
 * The lesson key an entry should cite: its own explicit `lessonKey` if it has
 * one, otherwise its cluster's canonical key.
 */
export function lessonKeyForEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.lessonKey === 'string' && entry.lessonKey) return entry.lessonKey;
  return clusterForEntry(entry)?.lessonKey ?? null;
}

/** Every map entry belonging to a cluster, by id. Order preserved. */
export function clusterMembers(clusterId, map = []) {
  if (!Array.isArray(map)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of map) {
    if (clusterForEntry(entry)?.id !== clusterId) continue;
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}

/**
 * The join to `dedupe`: does a group of memory keys (a dedupe cluster's
 * members) already belong to a NAMED recurrence class? A member's `key`
 * resolves to a class when it equals that class's canonical `lessonKey` or
 * appears in its `sourceKeys` — the other sightings the class is known to
 * subsume.
 *
 * This is a stronger signal than lexical similarity alone: a dedupe cluster
 * that resolves here isn't just "these look alike", it's "this is (at least
 * partly) another sighting of a class we already named and can cite."
 *
 * `pure: true` only when EVERY member resolves to the SAME single class — the
 * strongest case, where merging under the class's canonical key loses no
 * stragglers. A mixed match (some members resolve, some don't, or they split
 * across classes) still reports the majority class via `matched`, so a
 * partial hit isn't silently discarded — ties break by registry order.
 *
 * Total: no members, or no member resolving to any class, returns the null
 * shape rather than throwing or returning undefined fields.
 */
export function resolveRecurrenceClass(members = [], clusters = RECURRENCE_CLUSTERS) {
  const list = Array.isArray(members) ? members : [];
  const counts = new Map();
  const matched = [];
  for (const m of list) {
    const key = m?.key;
    if (typeof key !== 'string' || !key) continue;
    for (const cl of clusters) {
      const sourceKeys = Array.isArray(cl.sourceKeys) ? cl.sourceKeys : [];
      if (key !== cl.lessonKey && !sourceKeys.includes(key)) continue;
      matched.push(key);
      counts.set(cl.id, (counts.get(cl.id) ?? 0) + 1);
      break;
    }
  }
  if (matched.length === 0) return { classId: null, className: null, matched: [], pure: false };

  let bestId = null;
  let bestCount = -1;
  for (const cl of clusters) {
    const n = counts.get(cl.id) ?? 0;
    if (n > bestCount) {
      bestCount = n;
      bestId = cl.id;
    }
  }
  const best = clusters.find((cl) => cl.id === bestId) ?? null;
  const pure = matched.length === list.length && counts.size === 1;
  return { classId: best?.id ?? null, className: best?.name ?? null, matched, pure };
}
