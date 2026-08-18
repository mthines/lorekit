/**
 * Derive a {@link LoreGraph} from a page of memories.
 *
 * Pure and dependency-free (see the functional-core convention in
 * `packages/web/CLAUDE.md`), so the whole relationship model — which memories
 * are neighbours, how strongly, and what gets dropped when there are too many —
 * is unit-testable without a browser, a canvas, or a GPU.
 *
 * ## The cost model this is written against
 *
 * A free-plan account is capped at **5,000 active memories** (`docs/limits.md`),
 * so the node count has a known ceiling and instanced WebGL draws it in one
 * call. The part with no natural ceiling is the EDGES: "connect every pair that
 * shares a label" is `O(n²)` in the worst case, and a single label carried by
 * 3,000 memories would alone produce ~4.5 million lines — enough to blow the
 * frame budget, the layout budget and the user's ability to read anything.
 *
 * Three bounds keep it linear-ish and legible, in this order:
 *
 * 1. **Hub suppression.** A label (or key namespace, or repo) carried by more
 *    than {@link GraphBuildOptions.hubSize} memories is not an edge at all. It
 *    is a FACET — "everything here is a lesson" tells you nothing about which
 *    two memories relate — and it is exactly the term whose posting list makes
 *    the pair count quadratic. Dropping it removes the cost and the noise
 *    together, which is why it is the first bound rather than a later cap.
 * 2. **Degree cap.** No memory keeps more than
 *    {@link GraphBuildOptions.maxDegree} relation edges, taking its strongest
 *    first. A hairball around one node hides the very clustering the view
 *    exists to show.
 * 3. **Edge budget.** A final global cap, applied strongest-first.
 *
 * Every bound reports what it dropped in {@link LoreGraph.truncated}, because a
 * picture of "the shape of your lore" that quietly omits half of it is worse
 * than no picture.
 */

import { scopeType } from '@/lib/scope';
import type { EdgeKind, GraphEdge, GraphNode, GraphTruncation, LoreGraph } from './types';
import { EMPTY_GRAPH } from './types';

/**
 * The fields the builder reads off a memory.
 *
 * A structural subset rather than `LessonEntry` itself, so this module stays
 * usable from a test fixture, a Storybook story, and a future server-side
 * graph projection without any of them constructing a full lesson.
 */
export interface GraphMemoryInput {
  scope: string;
  key: string;
  tags?: readonly string[] | null;
  updated_at: string;
  archived_at?: string | null;
  origin_repo?: string | null;
  /** Recurrence (migration 00059). Absent on a row written before it. */
  seen_count?: number | null;
}

export interface GraphBuildOptions {
  /** Max memory nodes kept, most-recently-updated first. */
  maxNodes?: number;
  /**
   * Max memory↔memory RELATIONSHIPS kept, strongest first.
   *
   * Counted in distinct pairs, exactly like {@link maxDegree}, and for the same
   * reason: a pair that shares a label, a key namespace and a repo is one
   * relationship drawn three times over the same path, not three. Charging the
   * global budget per edge while the degree budget charges per neighbour let a
   * duplicate take the last slot from a genuinely new relationship.
   *
   * The drawn line count is therefore up to `kinds.length ×` this number in the
   * worst case. That is bounded (three, today) and costs GPU vertices rather
   * than legibility, which is the resource this budget is protecting.
   */
  maxEdges?: number;
  /**
   * Max distinct relation NEIGHBOURS per memory — not edges.
   *
   * The distinction is load-bearing. Two memories that share a label, a key
   * namespace AND an origin repo produce three edges between the same pair, and
   * counting edges would spend three of the budget on one neighbour: with
   * `maxDegree: 3` a hub would keep three lines to a single other node and be
   * declared full. Neighbours are what the budget is protecting — a node
   * tethered to twelve others is a hairball; a node with three parallel lines to
   * one other is a single, slightly bolder relationship.
   *
   * So an edge to an ALREADY-connected neighbour is free: it draws over the
   * same path and costs nothing in legibility.
   *
   * Scope edges are exempt entirely — they are the skeleton.
   */
  maxDegree?: number;
  /** A term shared by more than this many memories is a facet, not a relation. */
  hubSize?: number;
  /**
   * Relation kinds to derive. Membership matters; ORDER does not — the sort that
   * ranks candidates breaks ties on `KIND_RANK` and then on node indices, never
   * on the position a kind happened to occupy in this array.
   */
  kinds?: readonly Exclude<EdgeKind, 'scope'>[];
}

/**
 * How much a shared term of each kind is worth, relative to a shared label.
 *
 * Without this, Jaccard is **not comparable across kinds**. A key namespace and
 * an origin repo contribute exactly ONE term each, so every such pair scores a
 * perfect 1.0 — `shared 1 / union 1` — and sorts ahead of even a genuine label
 * twin before `maxDegree` gets a look in. The graph would then be dominated by
 * "these two lessons came from the same repo", which is the weakest evidence of
 * a relationship the model has and the least interesting thing to draw.
 *
 * The multipliers encode the evidence strength directly: sharing a whole label
 * vocabulary is a real statement about two memories; sharing a bucket namespace
 * is a weaker one; being written from the same repository is weaker still, and
 * is already visible from the scope clustering.
 */
export const KIND_WEIGHT: Record<Exclude<EdgeKind, 'scope'>, number> = {
  label: 1,
  key: 0.55,
  repo: 0.35,
};

/**
 * Tie-break order when two candidate edges score identically.
 *
 * Its only job is to make the result independent of the caller's `kinds` array
 * order. `Array#sort` is stable, so without an explicit kind term a tie would be
 * resolved by whichever kind was generated first — meaning
 * `kinds: ['label','repo']` and `['repo','label']` could keep different edges
 * under a tight `maxDegree`. Same inputs, different picture, no reason.
 */
const KIND_RANK: Record<EdgeKind, number> = { scope: 0, label: 1, key: 2, repo: 3 };

/**
 * Defaults chosen against the 5,000-memory plan ceiling.
 *
 * `maxNodes` is the ceiling itself: below it nothing is dropped, so the common
 * account sees its whole graph.
 *
 * The 5,000 cap counts ACTIVE memories only — archiving frees headroom
 * immediately (`docs/limits.md`) — so an account can hold more than 5,000 rows
 * in total. That does not make this budget too small, because the two
 * populations never arrive together: the Explorer's Status control is
 * single-select (`active` | `archived` | `expiring`) and the list is fetched
 * with one `archived` value, so the map is only ever handed one population at a
 * time. If a future caller ever feeds it both, `truncated` will say so rather
 * than the map silently thinning out.
 *
 * `maxEdges` is ~3× the node ceiling because a
 * readable graph is sparse — past roughly three edges per node the screen is a
 * fog of lines regardless of how fast it renders. `hubSize` of 64 is the point
 * where a shared term stops discriminating: a label on 65 of your memories is
 * describing a category, and categories are already drawn as scopes.
 */
export const GRAPH_DEFAULTS = {
  maxNodes: 5_000,
  maxEdges: 15_000,
  maxDegree: 12,
  hubSize: 64,
  kinds: ['label', 'key', 'repo'] as const,
} satisfies Required<GraphBuildOptions>;

/**
 * Fill in the defaults, treating an explicit `undefined` as "not supplied".
 *
 * `{ ...GRAPH_DEFAULTS, ...options }` does not — a spread copies an own
 * property even when its value is `undefined`, so the default is overwritten
 * with nothing. That is the shape every caller building options from optional
 * state produces (`{ maxNodes: filters.maxNodes }` with the filter unset), and
 * the failure is silent and total: `{ maxNodes: undefined }` returned ZERO
 * nodes (`Math.max(undefined, 0)` is `NaN`, and `slice(0, NaN)` is empty), while
 * `{ hubSize: undefined }` switched hub suppression off entirely and put the
 * quadratic path back.
 */
function withDefaults(options: GraphBuildOptions): Required<GraphBuildOptions> {
  return {
    maxNodes: options.maxNodes ?? GRAPH_DEFAULTS.maxNodes,
    maxEdges: options.maxEdges ?? GRAPH_DEFAULTS.maxEdges,
    maxDegree: options.maxDegree ?? GRAPH_DEFAULTS.maxDegree,
    hubSize: options.hubSize ?? GRAPH_DEFAULTS.hubSize,
    kinds: options.kinds ?? GRAPH_DEFAULTS.kinds,
  };
}

/** The natural key — the one identity that survives a refetch and a re-sort. */
export function memoryNodeId(memory: Pick<GraphMemoryInput, 'scope' | 'key'>): string {
  return `${memory.scope}::${memory.key}`;
}

/** A scope node's id, namespaced so it can never collide with a memory's. */
export function scopeNodeId(scope: string): string {
  return `scope:${scope}`;
}

/**
 * The `namespace` of `namespace::slug` keys, or `null` for an un-namespaced key.
 *
 * The convention is real and load-bearing in this product — every
 * self-improvement loop writes `<bucket>-lessons::<slug>` — so two memories
 * sharing a prefix are siblings in the same bucket, which is a relation worth a
 * line. A key with no `::` has no siblings by this rule rather than being
 * grouped with every other un-namespaced key.
 */
export function keyNamespace(key: string): string | null {
  const at = key.indexOf('::');
  return at > 0 ? key.slice(0, at) : null;
}

/**
 * `log1p`-scaled across the OBSERVED RANGE into `[0, 1]`, so one 400× outlier
 * cannot flatten the rest.
 *
 * **No spread means zero, not one, and "no spread" means `min === max`.** When
 * every candidate carries the same value there is no signal to encode and the
 * honest rendering is the BASE size — `weight: 0`. Two guards got this wrong in
 * turn, and both drew the whole graph at maximum radius:
 *
 * - Returning 1 on no spread: the size channel stopped meaning anything while
 *   shouting that everything was important.
 * - Guarding on `max <= 1` rather than on the spread: that only catches the
 *   all-absent case. A uniform `seen_count: 3`, or two scopes of equal size,
 *   sailed past it and every node came out at `weight: 1` again.
 *
 * **Scaling starts at the observed MINIMUM, not at zero**, for the same reason.
 * An absent `seen_count` reads as 1 (recurrence arrives with migration 00059,
 * so a whole account can legitimately have none). Scaled from zero, giving a
 * single row `seen_count: 2` shoved the other 499 from `0` to `0.631` —
 * three-fifths of the size channel spent on rows that carry no recurrence at
 * all. Anchored at the minimum, the floor of the observed range is the base
 * size and the range above it is what gets drawn.
 */
function normalizedWeight(value: number, min: number, max: number): number {
  const spread = max - min;
  if (!(spread > 0)) return 0;
  return Math.log1p(Math.max(value - min, 0)) / Math.log1p(spread);
}

/**
 * The `[min, max]` of a set of values, or `[0, 0]` when there are none.
 *
 * Folded rather than `Math.min(...values)`: the spread form throws
 * `RangeError: Maximum call stack size exceeded` once the array is long enough,
 * and this one is sized by `maxNodes` — a caller may legitimately raise it past
 * the default 5,000.
 */
function range(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 0];
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

/**
 * Deterministic order: newest first, natural key breaking ties.
 *
 * The tie-break is a plain code-unit comparison, NOT `localeCompare`.
 * `localeCompare` sorts by the runtime's default locale, so the same account
 * could order two same-timestamp memories differently in two browsers — and
 * since every entry in `edges` addresses nodes by INDEX, a different order is a
 * different graph. A code-unit compare is the same everywhere, which is what
 * the determinism claim requires.
 */
function byRecencyThenKey(a: GraphMemoryInput, b: GraphMemoryInput): number {
  const delta = Date.parse(b.updated_at) - Date.parse(a.updated_at);
  if (delta !== 0 && Number.isFinite(delta)) return delta;
  const left = memoryNodeId(a);
  const right = memoryNodeId(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `a|b` with the lower index first, so a pair has ONE key regardless of order. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Group node indices by a term, dropping terms that only one memory carries
 * (no pair to draw) and terms carried by more than `hubSize` (a facet).
 *
 * Returns the surviving index AND the set of terms suppressed as hubs. The
 * caller needs the second half to keep the Jaccard denominator honest — see
 * {@link pairsFromPostings}.
 */
function postingLists(
  terms: readonly (readonly string[])[],
  hubSize: number,
): { index: Map<string, number[]>; hubs: Set<string> } {
  const index = new Map<string, number[]>();
  terms.forEach((nodeTerms, node) => {
    for (const term of nodeTerms) {
      const list = index.get(term);
      if (list) list.push(node);
      else index.set(term, [node]);
    }
  });

  const hubs = new Set<string>();
  for (const [term, list] of index) {
    if (list.length > hubSize) hubs.add(term);
    if (list.length < 2 || list.length > hubSize) index.delete(term);
  }
  return { index, hubs };
}

/**
 * Pair up every posting list and accumulate a strength per pair.
 *
 * Strength is the **Jaccard** overlap of the two term sets — shared over union
 * — so two memories carrying the same single label score 1, while a memory with
 * twenty labels sharing one of them scores near zero. Normalising by the
 * SMALLER set instead (the obvious first attempt) scores both of those 1: any
 * single-label memory becomes a perfect twin of every memory that happens to
 * carry that label, which is precisely the false cluster this view must not
 * draw.
 *
 * **Hub terms are excluded from the union.** A term carried by more than
 * `hubSize` memories has been declared "not evidence of a relationship" — it
 * generates no pairs — and it must not be evidence *against* one either. Left
 * in the denominator it silently is: two memories sharing only a niche label,
 * each also carrying fifteen `loop::*`-style hub labels, scored 0.032 and sank
 * below a pair that shares one of two ordinary labels. That is the opposite of
 * what hub suppression is for.
 *
 * Single-occurrence terms DO stay in the denominator. They are real,
 * discriminating vocabulary — a memory with twenty labels nobody else carries
 * genuinely is less of a twin than one with two — they simply have no partner
 * in this dataset.
 */
function pairsFromPostings(
  index: Map<string, number[]>,
  termCount: readonly number[],
): Map<string, { source: number; target: number; shared: number }> {
  const pairs = new Map<string, { source: number; target: number; shared: number }>();
  for (const list of index.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const key = pairKey(a, b);
        const existing = pairs.get(key);
        if (existing) existing.shared += 1;
        else pairs.set(key, { source: Math.min(a, b), target: Math.max(a, b), shared: 1 });
      }
    }
  }
  for (const pair of pairs.values()) {
    const union =
      (termCount[pair.source] || 1) + (termCount[pair.target] || 1) - pair.shared;
    pair.shared = Math.min(1, pair.shared / Math.max(union, 1));
  }
  return pairs;
}

/**
 * Strongest first, then kind, then node indices.
 *
 * Every term after the first exists to make the ordering TOTAL: with only
 * `strength`, ties fall through to `Array#sort`'s stability and the result
 * depends on generation order — which is the caller's `kinds` array order. A
 * total order means the same inputs always draw the same graph, whichever way
 * they were handed in.
 */
function byStrength(a: GraphEdge, b: GraphEdge): number {
  if (b.strength !== a.strength) return b.strength - a.strength;
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.source !== b.source) return a.source - b.source;
  return a.target - b.target;
}

/**
 * Build the graph.
 *
 * The returned `nodes` array is memory nodes first, then scope nodes. Callers
 * rely on nothing about that order beyond its determinism — edges address nodes
 * by index — but the split keeps the GPU's instance buffer for the (numerous,
 * uniformly-sized) memory nodes contiguous.
 */
export function buildLoreGraph(
  memories: readonly GraphMemoryInput[],
  options: GraphBuildOptions = {},
): LoreGraph {
  const { maxNodes, maxEdges, maxDegree, hubSize, kinds } = withDefaults(options);
  if (memories.length === 0) return EMPTY_GRAPH;

  const truncated: GraphTruncation[] = [];

  // ── Nodes ───────────────────────────────────────────────────────────────
  const ordered = [...memories].sort(byRecencyThenKey);
  const kept = ordered.slice(0, Math.max(maxNodes, 0));
  if (kept.length < ordered.length) {
    truncated.push({ of: 'nodes', total: ordered.length, kept: kept.length });
  }

  const [minSeen, maxSeen] = range(kept.map((memory) => memory.seen_count ?? 1));
  const nodes: GraphNode[] = kept.map((memory) => ({
    kind: 'memory',
    id: memoryNodeId(memory),
    label: memory.key,
    scope: memory.scope,
    scopeType: scopeType(memory.scope),
    weight: normalizedWeight(memory.seen_count ?? 1, minSeen, maxSeen),
    tags: memory.tags ?? [],
    updatedAt: Date.parse(memory.updated_at) || 0,
    archived: Boolean(memory.archived_at),
  }));

  // One scope node per scope actually present, in first-appearance order.
  const scopeMembers = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const members = scopeMembers.get(node.scope);
    if (members) members.push(index);
    else scopeMembers.set(node.scope, [index]);
  });

  const [minMembers, maxMembers] = range([...scopeMembers.values()].map((m) => m.length));
  const scopeIndexOf = new Map<string, number>();
  for (const [scope, members] of scopeMembers) {
    scopeIndexOf.set(scope, nodes.length);
    nodes.push({
      kind: 'scope',
      id: scopeNodeId(scope),
      label: scope.split('::').pop() ?? scope,
      scope,
      scopeType: scopeType(scope),
      weight: normalizedWeight(members.length, minMembers, maxMembers),
      tags: [],
      // A scope is as fresh as its freshest memory, so an abandoned scope reads
      // as abandoned rather than borrowing "now" from the render.
      updatedAt: members.reduce((newest, i) => Math.max(newest, nodes[i].updatedAt), 0),
      archived: members.every((i) => nodes[i].archived),
    });
  }

  // ── Skeleton edges: every memory to its scope ───────────────────────────
  const edges: GraphEdge[] = [];
  for (const [scope, members] of scopeMembers) {
    const scopeIndex = scopeIndexOf.get(scope) ?? 0;
    for (const member of members) {
      edges.push({ source: member, target: scopeIndex, kind: 'scope', strength: 1 });
    }
  }

  // ── Relation edges ──────────────────────────────────────────────────────
  const termsFor: Record<Exclude<EdgeKind, 'scope'>, (m: GraphMemoryInput) => string[]> = {
    label: (m) => [...new Set(m.tags ?? [])],
    key: (m) => {
      const namespace = keyNamespace(m.key);
      return namespace ? [namespace] : [];
    },
    repo: (m) => (m.origin_repo ? [m.origin_repo] : []),
  };

  const candidates: GraphEdge[] = [];
  // Hub suppression across all kinds, so it can be reported as one bound rather
  // than three the reader has to add up.
  const sharedTerms = new Set<string>();
  const suppressedTerms = new Set<string>();

  for (const kind of kinds) {
    const terms = kept.map(termsFor[kind]);
    const { index, hubs } = postingLists(terms, hubSize);
    for (const term of index.keys()) sharedTerms.add(`${kind}:${term}`);
    for (const term of hubs) suppressedTerms.add(`${kind}:${term}`);
    const pairs = pairsFromPostings(
      index,
      // The union counts only terms that were allowed to be evidence.
      terms.map((nodeTerms) => nodeTerms.filter((term) => !hubs.has(term)).length),
    );
    for (const pair of pairs.values()) {
      candidates.push({
        source: pair.source,
        target: pair.target,
        kind,
        // Scaled so the score means the same thing across kinds — see KIND_WEIGHT.
        strength: pair.shared * KIND_WEIGHT[kind],
      });
    }
  }

  if (suppressedTerms.size > 0) {
    truncated.push({
      of: 'terms',
      total: sharedTerms.size + suppressedTerms.size,
      kept: sharedTerms.size,
    });
  }

  candidates.sort(byStrength);

  // Distinct NEIGHBOURS per node, not edge count — see `maxDegree`. A second
  // edge between an already-connected pair draws over the same path, so it
  // spends no legibility and must spend no budget.
  const neighbours: Map<number, Set<number>> = new Map();
  const neighboursOf = (node: number): Set<number> => {
    const existing = neighbours.get(node);
    if (existing) return existing;
    const created = new Set<number>();
    neighbours.set(node, created);
    return created;
  };

  const relations: GraphEdge[] = [];
  const drawnPairs = new Set<string>();
  for (const edge of candidates) {
    const sourceNeighbours = neighboursOf(edge.source);
    const targetNeighbours = neighboursOf(edge.target);
    const alreadyConnected = sourceNeighbours.has(edge.target);

    // Both budgets count RELATIONSHIPS. A parallel edge over an already-drawn
    // pair is the same relationship expressed by a second kind, so it is free in
    // both — otherwise the global budget would spend its last slot on a
    // duplicate while a genuinely new pair went undrawn.
    if (!alreadyConnected) {
      if (drawnPairs.size >= maxEdges) continue;
      if (sourceNeighbours.size >= maxDegree || targetNeighbours.size >= maxDegree) continue;
    }

    sourceNeighbours.add(edge.target);
    targetNeighbours.add(edge.source);
    drawnPairs.add(pairKey(edge.source, edge.target));
    relations.push(edge);
  }

  // Reported in relationships too, for the same reason: `{total: 3, kept: 1}`
  // for a single pair that happens to share three dimensions reads as three
  // dropped relationships when only one ever existed.
  const candidatePairs = new Set(candidates.map((edge) => pairKey(edge.source, edge.target)));
  if (drawnPairs.size < candidatePairs.size) {
    truncated.push({ of: 'edges', total: candidatePairs.size, kept: drawnPairs.size });
  }

  return { nodes, edges: [...edges, ...relations], truncated };
}
