/**
 * Near-duplicate clustering — the server-side core behind
 * `GET /memories/clusters` and the dashboard's Duplicate Clusters panel.
 *
 * ## Why this exists as a THIRD copy of a rule, and why that is not a mistake
 *
 * The Jaccard clustering here is a port of `packages/cli/src/shared/lessons-view.mjs`
 * (`tokenize` / `similarity` / `clusterDuplicates` / `clusterDuplicatesBlocked`),
 * which is what `lorekit dedupe` runs. The recurrence-class registry and the
 * candidate ranking are ports of `packages/cli/src/shared/recurrence-clusters.mjs`
 * and `packages/cli/src/shared/candidates-pure.mjs`, which is what
 * `lorekit invariants candidates` runs.
 *
 * Three runtimes cannot share one module: the CLI is a zero-dependency `.mjs`
 * package with no build step, this package is Node TypeScript, and the edge
 * function cannot import from `packages/` at all. So the rule exists in the CLI
 * and here, and this file is mirrored byte-for-byte into
 * `supabase/functions/_shared/clusters/duplicate-clusters.ts`.
 *
 * The two guards that make the duplication safe are DIFFERENT guards, because
 * the two duplications are different in kind:
 *
 *  - core ↔ edge mirror: same language, so `edge-parity.spec.ts` byte-compares
 *    the executable source (registered in `mirror-pairs.mjs`, `driftChecked: true`).
 *  - core ↔ CLI: different languages, so a byte comparison is unavailable and
 *    the guard is BEHAVIOURAL — `duplicate-clusters-parity.spec.ts` runs both
 *    implementations over shared fixtures and requires identical clusters.
 *    This is exactly the arrangement `lesson-rank-parity.spec.ts` uses to hold
 *    `lesson-rank.ts` to the CLI's `lessons-pure.mjs`.
 *
 * Without the second guard, `lorekit dedupe` and the dashboard panel would drift
 * into disagreeing about which lessons are duplicates — and the symptom ("the
 * CLI says three, the dashboard says two") is the kind nobody notices until they
 * are debugging something else.
 *
 * ## Read-only in a stronger sense than "no writes"
 *
 * Ported deliberately from `candidates-pure.mjs`'s header, because it is the
 * boundary the whole compile pipeline is built around: this module never
 * CLASSIFIES anything. It surfaces what a lesson already states about itself (a
 * parsed meta comment, a `seen_count`, a resolved recurrence class) and ranks
 * it. It does not decide whether a trigger-context is mechanically detectable,
 * and it does not validate `status` against a fixed vocabulary (none is defined
 * anywhere in this codebase). That judgment is the human step the "never
 * auto-compile, never auto-gate" rule protects, and a surface that started
 * making those calls would be the thing the rule exists to prevent.
 *
 * Pure and import-free: no I/O, no clock, no `Deno`/`process`. Total — malformed
 * input degrades to the empty/default case rather than throwing, so one bad row
 * in a candidate window can never fail the request.
 */

// ── The similarity heuristic ─────────────────────────────────────────────────

/**
 * Split a value into a set of lowercased alphanumeric word tokens — the unit of
 * comparison. Deliberately non-semantic: no stemming, no embeddings, no
 * stopword list, so the result is reproducible from the text alone and needs no
 * model or network.
 */
export function tokenize(value: unknown): Set<string> {
  return new Set(
    String(value == null ? '' : value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/**
 * Jaccard similarity (|A∩B| / |A∪B|) over two values' token sets — a
 * zero-dependency HEURISTIC, never a semantic measure.
 *
 * Two empty bodies are treated as identical (1); one empty against a non-empty
 * one is disjoint (0). Both edges are load-bearing rather than incidental: a
 * store with several blank-bodied rows should cluster them (they really are the
 * same non-lesson), while a blank row must never look 100% similar to a real
 * one just because the intersection is trivially the empty set.
 */
export function similarity(a: unknown, b: unknown): number {
  const sa = a instanceof Set ? (a as Set<string>) : tokenize(a);
  const sb = b instanceof Set ? (b as Set<string>) : tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** One row a cluster can be built from. Extra fields ride along untouched. */
export interface ClusterableEntry {
  scope?: string | null;
  key?: string | null;
  value?: string | null;
  seenCount?: number | null;
}

/** A group of rows the heuristic linked together. */
export interface DuplicateCluster<T extends ClusterableEntry = ClusterableEntry> {
  members: T[];
  size: number;
  /** The WEAKEST link that still met the threshold — how tight the cluster is. */
  minSimilarity: number;
  /** The strongest pair in the cluster. */
  maxSimilarity: number;
}

interface Indexed<T> {
  i: number;
  entry: T;
  tokens: Set<string>;
}

function assemble<T extends ClusterableEntry>(
  items: Indexed<T>[],
  find: (x: number) => number,
  pairs: { a: number; b: number; sim: number }[],
  threshold: number,
): DuplicateCluster<T>[] {
  const byRoot = new Map<number, Indexed<T>[]>();
  for (const it of items) {
    const r = find(it.i);
    const bucket = byRoot.get(r);
    if (bucket) bucket.push(it);
    else byRoot.set(r, [it]);
  }
  const clusters: DuplicateCluster<T>[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const idx = new Set(members.map((m) => m.i));
    const sims = pairs.filter((p) => idx.has(p.a) && idx.has(p.b)).map((p) => p.sim);
    clusters.push({
      members: members.map((m) => m.entry),
      size: members.length,
      minSimilarity: sims.length ? Math.min(...sims) : threshold,
      maxSimilarity: sims.length ? Math.max(...sims) : threshold,
    });
  }
  clusters.sort((x, y) => y.size - x.size);
  return clusters;
}

function unionFind(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  return { find, union: (a: number, b: number) => { parent[find(a)] = find(b); } };
}

/**
 * The REFERENCE all-pairs sweep: any pair whose `similarity` meets `threshold`
 * links its members transitively via union-find. Returns clusters of 2+ only,
 * largest first.
 *
 * Kept alongside the blocked variant on purpose. It is O(n²) and the handler
 * does not call it — its job is to make the blocked variant's equivalence a
 * TESTABLE PROPERTY rather than a claim in a comment. Delete it and the
 * inverted-index optimisation becomes unfalsifiable.
 */
export function clusterDuplicates<T extends ClusterableEntry>(
  entries: readonly T[] = [],
  threshold = 0.8,
): DuplicateCluster<T>[] {
  const items: Indexed<T>[] = entries.map((entry, i) => ({ i, entry, tokens: tokenize(entry?.value) }));
  const { find, union } = unionFind(items.length);
  const pairs: { a: number; b: number; sim: number }[] = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const sim = similarity(items[a].tokens, items[b].tokens);
      if (sim >= threshold) {
        pairs.push({ a, b, sim });
        union(a, b);
      }
    }
  }
  return assemble(items, find, pairs, threshold);
}

/**
 * Token-blocked clustering — the performance-bounded variant the handler calls.
 *
 * An inverted index (token → row indices) generates only the candidate pairs
 * that share at least one token, then the SAME Jaccard threshold and the SAME
 * union-find run over those. The results are provably identical to
 * `clusterDuplicates`:
 *
 *   IF similarity(a, b) >= threshold > 0 THEN a and b share at least one token,
 *   so the pair WILL be generated by the inverted-index sweep.
 *
 * Note the antecedent needs `threshold > 0`: at a threshold of exactly 0 every
 * pair qualifies including two token-disjoint rows, which share no index bucket
 * and so are never generated. The route's schema floors `threshold` at 0.5, and
 * `clusterDuplicates` remains the reference for anything below that.
 *
 * ## The zero-token clique is handled explicitly, and it has to be
 *
 * The implication above has one more exception, and it is REACHABLE rather than
 * theoretical: a row whose value tokenizes to nothing (empty, or punctuation
 * only) is in no index bucket at all, so no pair containing it is ever
 * generated — yet `similarity` treats two empty bodies as identical (1), so the
 * all-pairs reference clusters them at every threshold. Left alone, the blocked
 * variant silently drops that whole clique.
 *
 * An empty value is not hypothetical: `MemoryWriteSchema.value` is
 * `z.string().max(...).transform(trim)` with NO minimum, and the column is
 * `text not null` with only an upper length check (00001), so a write of `"   "`
 * stores `""`. So the zero-token rows are unioned explicitly below.
 *
 * **The CLI's `clusterDuplicatesBlocked` (`lessons-view.mjs`) does NOT do this
 * and its "provably identical" comment is wrong for exactly this input** —
 * `lorekit dedupe` reports no cluster where the reference sweep reports one.
 * That is a bug in the CLI, not a behaviour to reproduce here: matching it would
 * mean shipping a panel that disagrees with the reference implementation the
 * repo already has. `duplicate-clusters-parity.spec.ts` therefore pins the CLI
 * agreement over realistic non-empty bodies and documents this one divergence
 * explicitly, rather than quietly weakening the equivalence property.
 */
export function clusterDuplicatesBlocked<T extends ClusterableEntry>(
  entries: readonly T[] = [],
  threshold = 0.8,
): DuplicateCluster<T>[] {
  const items: Indexed<T>[] = entries.map((entry, i) => ({ i, entry, tokens: tokenize(entry?.value) }));

  const invertedIndex = new Map<string, number[]>();
  for (const item of items) {
    for (const token of item.tokens) {
      const bucket = invertedIndex.get(token);
      if (bucket) bucket.push(item.i);
      else invertedIndex.set(token, [item.i]);
    }
  }

  // Encoded pair keys rather than a nested Set, so a pair sharing twelve tokens
  // is compared once instead of twelve times.
  const candidatePairs = new Set<string>();
  for (const indices of invertedIndex.values()) {
    for (let x = 0; x < indices.length; x += 1) {
      for (let y = x + 1; y < indices.length; y += 1) {
        const a = Math.min(indices[x], indices[y]);
        const b = Math.max(indices[x], indices[y]);
        candidatePairs.add(`${a}:${b}`);
      }
    }
  }

  // Every zero-token row is similar (1) to every other zero-token row and
  // disjoint (0) from everything else, so they form one clique the inverted
  // index cannot see. Enumerated as consecutive pairs rather than all-pairs:
  // union-find makes the clique transitively, and `assemble` only needs enough
  // pairs to report a similarity range that is 1 either way.
  const emptyIndices = items.filter((it) => it.tokens.size === 0).map((it) => it.i);
  for (let x = 1; x < emptyIndices.length; x += 1) {
    candidatePairs.add(`${emptyIndices[x - 1]}:${emptyIndices[x]}`);
  }

  const { find, union } = unionFind(items.length);
  const pairs: { a: number; b: number; sim: number }[] = [];
  for (const pairKey of candidatePairs) {
    const sep = pairKey.indexOf(':');
    const a = Number(pairKey.slice(0, sep));
    const b = Number(pairKey.slice(sep + 1));
    const sim = similarity(items[a].tokens, items[b].tokens);
    if (sim >= threshold) {
      pairs.push({ a, b, sim });
      union(a, b);
    }
  }

  return assemble(items, find, pairs, threshold);
}

// ── The named recurrence classes ─────────────────────────────────────────────

/**
 * One named class of repeated failure.
 *
 * A cluster asserts that several distinct memories are really one class — which
 * is the claim a groom-merge would act on — so adding one is a deliberate act,
 * never a side effect of a scan. Two entries sharing a `lessonKey` but not a
 * cluster is a smell: they are the same class and should say so.
 */
export interface RecurrenceCluster {
  /** Stable slug. */
  id: string;
  /** One line: the SHAPE of the recurrence. */
  name: string;
  /** The canonical memory key an entry in this class cites. */
  lessonKey: string;
  /** Why this class recurs — what a human hitting it needs to read. */
  why: string;
  /** Other memory keys this class is known to subsume. */
  sourceKeys?: readonly string[];
}

/**
 * The registry.
 *
 * Kept in sync with `packages/cli/src/shared/recurrence-clusters.mjs` by
 * `duplicate-clusters-parity.spec.ts`, which compares the two id/name/lessonKey
 * triples. The CLI copy is the origin — it is where a human adds a class while
 * writing a Surface-Partner Map entry — so a divergence should be resolved by
 * bringing this copy in line, not the other way round.
 */
export const RECURRENCE_CLUSTERS: readonly RecurrenceCluster[] = [
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

/** What a cluster resolved to, if anything. */
export interface ResolvedRecurrenceClass {
  classId: string | null;
  className: string | null;
  /** The member keys that resolved to a class. */
  matched: string[];
  /** True only when EVERY member resolves to the SAME single class. */
  pure: boolean;
}

/**
 * Does a group of members already belong to a NAMED recurrence class?
 *
 * A member resolves when its `key` equals a class's canonical `lessonKey` or
 * appears in its `sourceKeys`. This is a stronger signal than lexical
 * similarity alone: a cluster that resolves here is not just "these look
 * alike", it is "this is (at least partly) another sighting of a class we
 * already named and can cite".
 *
 * `pure` is true ONLY when every member resolves to one class — the strongest
 * case, where merging under the class's canonical key loses no stragglers. A
 * mixed match (some members resolve, some do not, or they split across classes)
 * still reports the majority class through `classId`, so a partial hit is not
 * silently discarded; ties break by registry order. The distinction is the
 * whole reason `pure` is a separate field rather than "did it match" — a UI
 * that treated a mixed match as pure would be inviting a merge that drops rows.
 *
 * Total: no members, or no member resolving, returns the null shape.
 */
export function resolveRecurrenceClass(
  members: readonly { key?: string | null }[] = [],
  clusters: readonly RecurrenceCluster[] = RECURRENCE_CLUSTERS,
): ResolvedRecurrenceClass {
  const list = Array.isArray(members) ? members : [];
  const counts = new Map<string, number>();
  const matched: string[] = [];
  for (const m of list) {
    const key = m?.key;
    if (typeof key !== 'string' || !key) continue;
    for (const cl of clusters) {
      const sourceKeys = cl.sourceKeys ?? [];
      if (key !== cl.lessonKey && !sourceKeys.includes(key)) continue;
      matched.push(key);
      counts.set(cl.id, (counts.get(cl.id) ?? 0) + 1);
      break;
    }
  }
  if (matched.length === 0) return { classId: null, className: null, matched: [], pure: false };

  let bestId: string | null = null;
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

// ── The candidate ranking ────────────────────────────────────────────────────

/**
 * `[\s\S]*?` up to the closing `-->` rather than a character class excluding
 * `>`: a trigger-context containing e.g. `length > 0` is legitimate prose, and
 * excluding the character silently dropped `seen_count`/`status` for that whole
 * lesson. Non-greedy so the first comment wins.
 */
const META_COMMENT_RE = /<!--\s*meta:([\s\S]*?)-->/;
const META_FIELD_RE = /([\w-]+)=("(?:[^"\\]|\\.)*"|\S+)/g;

/**
 * Extract the `<!-- meta: seen_count=1 status=active expires=<iso>
 * trigger-context="<signal>" -->` convention the `lorekit-setup` skill
 * documents.
 *
 * READ-ONLY extraction for a human's judgment, not a schema this enforces: a
 * lesson written before (or without) the convention is not an error, just a
 * candidate with no meta fields. Absent or malformed input yields `{}`, never a
 * throw.
 */
export function parseMetaComment(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {};
  const m = META_COMMENT_RE.exec(value);
  if (!m) return {};
  const out: Record<string, string> = {};
  META_FIELD_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = META_FIELD_RE.exec(m[1]))) {
    const [, k, rawV] = mm;
    out[k] =
      rawV.startsWith('"') && rawV.endsWith('"') ? rawV.slice(1, -1).replace(/\\"/g, '"') : rawV;
  }
  return out;
}

function totalSeen(members: readonly ClusterableEntry[] = []): number {
  return (members ?? []).reduce(
    (n, m) => n + (Number.isFinite(m?.seenCount) ? (m.seenCount as number) : 0),
    0,
  );
}

function distinctScopeCount(members: readonly ClusterableEntry[] = []): number {
  return new Set((members ?? []).map((m) => m?.scope)).size;
}

export const DEFAULT_MIN_SEEN_COUNT = 3;

/**
 * Is this cluster's recurrence signal real?
 *
 * Either the summed `seenCount` across members crosses `minSeenCount` — the SUM
 * rather than any single member's count, since the whole pitch of a candidate is
 * "these N sightings are really one entry" — or a member's own meta comment
 * already declares a non-`active` status. The disjunction matters: a lesson
 * somebody marked `structural` is a candidate on that evidence alone, however
 * few times it has recurred.
 */
export function isCandidate(
  members: readonly ClusterableEntry[] = [],
  { minSeenCount = DEFAULT_MIN_SEEN_COUNT }: { minSeenCount?: number } = {},
): boolean {
  if (totalSeen(members) >= minSeenCount) return true;
  return (members ?? []).some((m) => {
    const status = parseMetaComment(m?.value)['status'];
    return typeof status === 'string' && status.length > 0 && status !== 'active';
  });
}

/**
 * Recurrence × distinct scopes.
 *
 * The product rather than a sum: a lesson learned six times in one scope is a
 * local habit, while the same six sightings spread over three scopes is a
 * cross-cutting class — and it is the second that is worth naming as an
 * invariant. Multiplying is what makes the spread count.
 */
export function scoreCandidate(members: readonly ClusterableEntry[] = []): number {
  return totalSeen(members) * distinctScopeCount(members);
}

export interface RankedCandidate<T extends ClusterableEntry = ClusterableEntry> {
  members: (T & { meta: Record<string, string> })[];
  size: number;
  minSimilarity: number;
  maxSimilarity: number;
  recurrenceClass: ResolvedRecurrenceClass | null;
  score: number;
}

/**
 * Filter clusters down to candidates and rank them, highest score first.
 *
 * Ties break by member count, then by the first member's `scope::key` — fully
 * deterministic, so two identical requests cannot return two different orders.
 * Never mutates the input; each member is copied with its parsed `meta`
 * attached.
 *
 * `resolveClass` is injected rather than called directly so the ranking stays
 * testable without the registry, and so a caller can supply a narrowed registry.
 */
export function rankCandidates<T extends ClusterableEntry>(
  clusters: readonly DuplicateCluster<T>[] = [],
  {
    minSeenCount = DEFAULT_MIN_SEEN_COUNT,
    resolveClass,
  }: {
    minSeenCount?: number;
    resolveClass?: (members: readonly T[]) => ResolvedRecurrenceClass;
  } = {},
): RankedCandidate<T>[] {
  return (clusters ?? [])
    .filter((cl) => isCandidate(cl?.members, { minSeenCount }))
    .map((cl) => {
      const members = (cl.members ?? []).map((m) => ({ ...m, meta: parseMetaComment(m?.value) }));
      return {
        members,
        size: cl.size ?? members.length,
        minSimilarity: cl.minSimilarity,
        maxSimilarity: cl.maxSimilarity,
        recurrenceClass: typeof resolveClass === 'function' ? resolveClass(cl.members) : null,
        score: scoreCandidate(cl.members),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.size !== a.size) return b.size - a.size;
      const aKey = `${a.members[0]?.scope}::${a.members[0]?.key}`;
      const bKey = `${b.members[0]?.scope}::${b.members[0]?.key}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
}
