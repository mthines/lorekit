/**
 * Lesson ranking — the server-side twin of `packages/cli/src/lessons-pure.mjs`.
 *
 * WHY A SECOND IMPLEMENTATION EXISTS AT ALL, since this repo is otherwise
 * hostile to duplicated logic: the ranking has to run in two places that cannot
 * share a module. The SessionStart hook ranks in the CLI, which is a zero-dep
 * `.mjs` package with no build step; `GET /memories/relevant` ranks in a Deno
 * edge function, which cannot import from `packages/` at all (see the
 * `edge-bare-specifier` guard). Neither can consume the other.
 *
 * So the semantics are duplicated ON PURPOSE and held together by an executable
 * guard rather than by hope: `lesson-rank-parity.spec.ts` imports the CLI's
 * `.mjs` module directly and asserts the two produce the same scores and the
 * same order over a shared fixture set. A divergence fails the build in the
 * mocked `check` job. This is the `limits.ts` mirror pattern applied to the one
 * case where the two runtimes are different LANGUAGES, so a byte-for-byte file
 * comparison is not available.
 *
 * This file is itself mirrored verbatim into
 * `supabase/functions/_shared/lesson-rank.ts` (`edge-parity.spec.ts` MIRRORS),
 * which is what makes it reachable from the handler. Import-free for that
 * reason — no `zod`, no node builtins, nothing.
 *
 * Keep this file and `lessons-pure.mjs`'s ranking section in step. If you change
 * a factor here, change it there, and the parity spec will tell you if you
 * forgot.
 */

/** A row this module can score. Every field is optional — see `scoreLesson`. */
export interface RankableLesson {
  scope?: string;
  key?: string;
  value?: string;
  seenCount?: number | string | null;
  seen_count?: number | string | null;
  updatedAt?: string | Date | null;
  updated_at?: string | Date | null;
  updated?: string | Date | null;
  /** Server-supplied relevance in [0,1] — see `rankLessons`. */
  relevance?: number | null;
  /**
   * Outcome factor in [0,1] — applied/resolution history.
   * Absent → `normalizeOutcome` returns `COLD_START_OUTCOME_PRIOR`.
   * Derived by the edge handler from `tags` + `origin_pr`; not a DB column.
   */
  outcome?: number | null;
}

export interface RankWeights {
  recency: number;
  salience: number;
  relevance: number;
  outcome: number;
}

/**
 * Age at which the recency factor halves. Two weeks is roughly the span over
 * which a repo's working context turns over: yesterday's lesson should clearly
 * outrank last month's, without last month's dropping to nothing.
 */
export const RECENCY_HALF_LIFE_DAYS = 14;

/** Equal quarters. Deliberately untuned — see `lessons-pure.mjs`. */
export const DEFAULT_RANK_WEIGHTS: RankWeights = { recency: 1, salience: 1, relevance: 1, outcome: 1 };

/**
 * The cold-start prior for the outcome factor. A new lesson with no applied /
 * resolution history gets this value rather than 0. The rationale: scoring
 * absent outcome at 0 would sink every new lesson below stale ones purely for
 * lacking outcome history (outcome-lag). 0.5 is the neutral midpoint of [0,1]
 * — a cold lesson contributes an average outcome term, so it ranks on
 * recency and relevance instead of being penalised for being new.
 *
 * This is the ONE deliberate asymmetry vs `normalizeRelevance` (which returns
 * 0 for absent / unreadable input). Mirrored byte-identically in the edge twin
 * and `packages/cli/src/lessons-pure.mjs`.
 */
export const COLD_START_OUTCOME_PRIOR = 0.5;

/** Two scores closer than this are the same score. */
export const SCORE_EPSILON = 1e-9;

const MS_PER_DAY = 86400000;

function timeOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Recency in [0,1]: 1 for now, 0.5 at one half-life.
 *
 * Unknown scores 0, not 0.5 — treating unknown as average would let a row with
 * no timestamp outrank a real one that is merely a month old. A future
 * timestamp clamps to 1 rather than exceeding it: writer/reader clock skew is
 * ordinary, and an unbounded score would beat every honestly-dated row.
 */
export function recencyFactor(
  updatedAt: unknown,
  now: unknown,
  halfLifeDays: number = RECENCY_HALF_LIFE_DAYS,
): number {
  const t = timeOf(updatedAt);
  const nowMs = timeOf(now);
  if (t === null || nowMs === null) return 0;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : RECENCY_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  return Math.exp((-Math.LN2 * ageDays) / halfLife);
}

/**
 * Salience in [0,1] — recurrence relative to the most-recurring row in the same
 * candidate set. A set whose maximum is 0 or 1 yields 0 for everyone: nothing in
 * it has recurred, so the factor has nothing to say and the others decide.
 *
 * A `seenCount` ABOVE `maxSeenCount` is clamped to 1 rather than allowed to
 * exceed it, for the same reason `recencyFactor` clamps a future timestamp.
 * `rankLessons` derives the maximum from the set, so in-set the clamp never
 * binds; it binds when a caller reaches this (or `scoreLesson`) directly with a
 * maximum that is not the set's, and without it the `[0,1]` both docblocks
 * promise would simply be false — `salienceFactor(5, 2)` is 1.63.
 */
export function salienceFactor(seenCount: unknown, maxSeenCount: unknown): number {
  const n = typeof seenCount === 'number' && Number.isFinite(seenCount) ? Math.max(0, seenCount) : 0;
  const max = typeof maxSeenCount === 'number' && Number.isFinite(maxSeenCount) ? Math.max(0, maxSeenCount) : 0;
  if (max <= 1) return 0;
  return Math.min(1, Math.log1p(n) / Math.log1p(max));
}

/**
 * The recurrence count off a row, in either spelling. Unreadable is 0 — no
 * evidence of recurrence, which is not the same claim as one sighting.
 */
export function seenCountFrom(entry: RankableLesson | null | undefined): number {
  const raw = entry?.seenCount ?? entry?.seen_count;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The update timestamp off a row, in any of the three spellings. */
export function updatedAtFrom(entry: RankableLesson | null | undefined): unknown {
  return entry?.updatedAt ?? entry?.updated_at ?? entry?.updated;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Clamp a server-supplied relevance into [0,1]; anything unreadable is 0. */
export function normalizeRelevance(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalize an outcome value into [0,1]. Absent or unreadable input returns
 * `COLD_START_OUTCOME_PRIOR` — the deliberate asymmetry vs `normalizeRelevance`
 * (which returns 0 for absent input). A present value is clamped to [0,1].
 *
 * The cold-start prior ensures a new lesson with no outcome history is not
 * penalised during outcome-lag — it contributes an average outcome term and
 * ranks on recency + relevance instead.
 */
export function normalizeOutcome(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return COLD_START_OUTCOME_PRIOR;
  return Math.min(1, Math.max(0, n));
}

export interface ScoreOptions {
  now?: unknown;
  weights?: Partial<RankWeights>;
  maxSeenCount?: number;
  halfLifeDays?: number;
}

/**
 * Score one row in [0,1].
 *
 * UNLIKE the CLI twin, relevance is not computed here from a term list: on the
 * server it is Postgres's FTS rank, already computed by the query that selected
 * the candidate, so it arrives on the row as `relevance` and is only clamped.
 * That is the one intentional difference between the two implementations, and
 * the parity spec pins the two to agree whenever `relevance` is supplied
 * explicitly on both sides.
 *
 * The weighted sum is divided by the total weight so the result stays in [0,1]
 * whatever weights are supplied. A weight set summing to zero falls back to the
 * defaults rather than dividing by zero.
 */
export function scoreLesson(entry: RankableLesson | null | undefined, options: ScoreOptions = {}): number {
  const { now = Date.now(), weights, maxSeenCount = 0, halfLifeDays = RECENCY_HALF_LIFE_DAYS } = options;
  const w: RankWeights = {
    recency: numberOr(weights?.recency, DEFAULT_RANK_WEIGHTS.recency),
    salience: numberOr(weights?.salience, DEFAULT_RANK_WEIGHTS.salience),
    relevance: numberOr(weights?.relevance, DEFAULT_RANK_WEIGHTS.relevance),
    outcome: numberOr(weights?.outcome, DEFAULT_RANK_WEIGHTS.outcome),
  };
  const total = w.recency + w.salience + w.relevance + w.outcome;
  if (!(total > 0)) {
    return scoreLesson(entry, { now, weights: DEFAULT_RANK_WEIGHTS, maxSeenCount, halfLifeDays });
  }
  const recency = recencyFactor(updatedAtFrom(entry), now, halfLifeDays);
  const salience = salienceFactor(seenCountFrom(entry), maxSeenCount);
  const relevance = normalizeRelevance(entry?.relevance);
  const outcome = normalizeOutcome(entry?.outcome);
  return (w.recency * recency + w.salience * salience + w.relevance * relevance + w.outcome * outcome) / total;
}

export interface RankOptions extends Omit<ScoreOptions, 'maxSeenCount'> {
  /** Scope precedence, most-specific first. Defaults to first-appearance order. */
  scopeOrder?: readonly string[] | null;
}

export interface RankedLesson<T extends RankableLesson> {
  entry: T;
  score: number;
}

/**
 * MMR λ (lambda) — weight given to relevance vs diversity in the MMR objective.
 * At 0.7 the selector favours relevance, with 0.3 of the budget for diversity.
 * Anchored to Carbonell & Goldstein (1998), the original MMR paper.
 * Mirrored byte-identically in the edge twin and `packages/cli/src/lessons-pure.mjs`.
 */
export const MMR_LAMBDA = 0.7;

/**
 * Tokenise a lesson `value` into a deduplicated Set: case-fold, split on
 * non-alphanumeric characters, drop empties. Dependency-free and deterministic
 * so it mirrors byte-identically across TS, Deno, and the `.mjs` twin.
 *
 * PERF: `selectDiverse` calls this ONCE per candidate before the MMR loop and
 * caches the result — see the `tokens` field it builds. `jaccardSimilarity`
 * takes the cached Sets, so the O(k²) pairwise comparisons inside the loop cost
 * no tokenisation. Do NOT re-introduce a `tokenize(value)` call inside the loop:
 * that regresses the hot path to O(n·k²) tokenisations (measured 34s CPU at
 * n=200/k=100, `tools.ts` max with 1.5KB values).
 */
function tokenizeValue(v: unknown): Set<string> {
  const tokens = String(v ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(tokens);
}

/**
 * Word/token Jaccard similarity between two PRE-TOKENISED value Sets:
 * |A∩B| / |A∪B|. Both-empty → 0.
 *
 * Takes Sets rather than raw values on purpose — the caller tokenises each
 * candidate once (see `tokenizeValue`) so this stays allocation-free on the
 * O(k²) hot path.
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SelectDiverseOptions {
  lambda?: number;
}

/**
 * Select the top-K lessons from a ranked list using Maximal Marginal Relevance
 * (Carbonell & Goldstein, 1998).
 *
 * Greedy MMR: seed with the highest-ranked candidate, then at each step pick
 * the unselected candidate that maximises
 *   λ·quantise(score(i)) − (1−λ)·max_{j∈selected} jaccardSimilarity(value_i, value_j)
 * Ties in the MMR objective break by input order (first-wins) so the result
 * is deterministic over the already-rank-ordered input.
 *
 * SCORE QUANTISATION: the relevance term uses the score SNAPPED onto the
 * `SCORE_EPSILON` grid — the exact grid `rankLessons` buckets on for its
 * scope-precedence tie-break. Two scores within `SCORE_EPSILON` land in the same
 * bucket, so the MMR objective sees them as equal and the input order (which
 * `rankLessons` already sorted by scope precedence, then key) decides between
 * them. Comparing the RAW score here would let a 1e-10 float difference override
 * scope precedence — the lower-precedence scope could win a near-tie MMR pick.
 *
 * PERF — the algorithm is O(n·k), and BOTH factors that could regress it to
 * O(n·k²) are held down explicitly:
 *   1. TOKENISE axis: each candidate's `value` is tokenised ONCE up front (the
 *      `tokens` field) so the pairwise Jaccard comparisons never tokenise —
 *      O(n) tokenisations total. See `tokenizeValue`.
 *   2. INTERSECTION axis: each remaining candidate carries a RUNNING `maxSim`
 *      (its greatest Jaccard similarity to anything selected so far). The
 *      objective reads that cached scalar — it does NOT loop over `selected`.
 *      After each pick we update `maxSim` for the still-remaining candidates
 *      against the ONE just-selected entry only. That is k picks × n candidates
 *      = O(n·k) Jaccard intersections total, not O(n·k²).
 * Re-introducing either an in-loop `tokenizeValue` call OR an inner
 * `for (… of selected)` maxSim recomputation silently restores O(n·k²) —
 * measured 2.6s CPU at n=200/k=100 vs 58ms for the running form. Don't.
 *
 * Always-on for ranked mode — no optional param needed. The recency wire path is
 * never affected.
 */
export function selectDiverse<T extends RankableLesson>(
  ranked: readonly RankedLesson<T>[],
  k: number,
  options: SelectDiverseOptions = {},
): RankedLesson<T>[] {
  const lambda = typeof options.lambda === 'number' && Number.isFinite(options.lambda)
    ? options.lambda
    : MMR_LAMBDA;
  if (!Array.isArray(ranked) || ranked.length === 0 || k <= 0) return [];
  const selected: RankedLesson<T>[] = [];
  // Pre-tokenise every candidate ONCE and snap its score onto the SCORE_EPSILON
  // grid up front. `maxSim` is the running greatest Jaccard similarity to any
  // already-selected entry — 0 while nothing is selected. The loop below reads
  // these caches; it never tokenises, re-quantises, or rescans `selected`.
  const remaining = ranked.map((r) => ({
    ranked: r,
    tokens: tokenizeValue(r.entry.value),
    qScore: Math.round(r.score / SCORE_EPSILON) * SCORE_EPSILON,
    maxSim: 0,
  }));
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      // Reads the cached running maxSim — no inner scan over `selected`.
      const mmr = lambda * candidate.qScore - (1 - lambda) * candidate.maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    const [justSelected] = remaining.splice(bestIdx, 1);
    selected.push(justSelected.ranked);
    // Fold the just-selected entry into every remaining candidate's running
    // maxSim — one Jaccard per remaining candidate per pick, so O(n·k) total.
    for (const candidate of remaining) {
      const sim = jaccardSimilarity(candidate.tokens, justSelected.tokens);
      if (sim > candidate.maxSim) candidate.maxSim = sim;
    }
  }
  return selected;
}

/**
 * Rank rows best-first, returning `{ entry, score }` pairs in a NEW array.
 *
 * The score is returned rather than discarded because this one feeds an API
 * response — a caller deciding whether a hit is worth reading needs to see how
 * confident the ranking is, and a bare order cannot say "these two are
 * basically tied".
 *
 * Ties break by scope precedence, then key, then input position — identical to
 * the CLI twin, so a set ranked in either runtime comes out in the same order.
 */
export function rankLessons<T extends RankableLesson>(
  entries: readonly T[] = [],
  options: RankOptions = {},
): RankedLesson<T>[] {
  const { now = Date.now(), weights, halfLifeDays = RECENCY_HALF_LIFE_DAYS, scopeOrder = null } = options;
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e): e is T => Boolean(e) && typeof e === 'object',
  );
  if (list.length === 0) return [];

  let maxSeenCount = 0;
  for (const e of list) maxSeenCount = Math.max(maxSeenCount, seenCountFrom(e));

  const rankByScope = new Map<string | undefined, number>();
  for (const s of Array.isArray(scopeOrder) ? scopeOrder : []) {
    if (!rankByScope.has(s)) rankByScope.set(s, rankByScope.size);
  }
  for (const e of list) {
    if (e.scope !== undefined && !rankByScope.has(e.scope)) rankByScope.set(e.scope, rankByScope.size);
  }

  const scored = list.map((entry, index) => {
    const score = scoreLesson(entry, { now, weights, maxSeenCount, halfLifeDays });
    return {
      entry,
      index,
      score,
      // The score rounded onto the SCORE_EPSILON grid. Comparing THIS rather
      // than the raw score is what keeps "close enough to be a tie" TRANSITIVE:
      // `Math.abs(a - b) <= SCORE_EPSILON` is not transitive, so a chain of
      // near-tied rows (each within epsilon of its neighbour but not of the
      // ends) can order inconsistently — the exact form the CLI twin rejects.
      // A score is in [0,1] and the grid is 1e-9, so the bucket is always a
      // safe integer. Mirrors `lessons-pure.mjs`.
      bucket: Math.round(score / SCORE_EPSILON),
      scopeRank: rankByScope.has(entry.scope) ? (rankByScope.get(entry.scope) as number) : Number.MAX_SAFE_INTEGER,
      key: String(entry.key ?? ''),
    };
  });

  scored.sort((a, b) => {
    if (a.bucket !== b.bucket) return b.bucket - a.bucket;
    if (a.scopeRank !== b.scopeRank) return a.scopeRank - b.scopeRank;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.index - b.index;
  });

  return scored.map((s) => ({ entry: s.entry, score: s.score }));
}
