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
}

export interface RankWeights {
  recency: number;
  salience: number;
  relevance: number;
}

/**
 * Age at which the recency factor halves. Two weeks is roughly the span over
 * which a repo's working context turns over: yesterday's lesson should clearly
 * outrank last month's, without last month's dropping to nothing.
 */
export const RECENCY_HALF_LIFE_DAYS = 14;

/** Equal thirds. Deliberately untuned — see `lessons-pure.mjs`. */
export const DEFAULT_RANK_WEIGHTS: RankWeights = { recency: 1, salience: 1, relevance: 1 };

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
  };
  const total = w.recency + w.salience + w.relevance;
  if (!(total > 0)) {
    return scoreLesson(entry, { now, weights: DEFAULT_RANK_WEIGHTS, maxSeenCount, halfLifeDays });
  }
  const recency = recencyFactor(updatedAtFrom(entry), now, halfLifeDays);
  const salience = salienceFactor(seenCountFrom(entry), maxSeenCount);
  const relevance = normalizeRelevance(entry?.relevance);
  return (w.recency * recency + w.salience * salience + w.relevance * relevance) / total;
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

  const scored = list.map((entry, index) => ({
    entry,
    index,
    score: scoreLesson(entry, { now, weights, maxSeenCount, halfLifeDays }),
    scopeRank: rankByScope.has(entry.scope) ? (rankByScope.get(entry.scope) as number) : Number.MAX_SAFE_INTEGER,
    key: String(entry.key ?? ''),
  }));

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > SCORE_EPSILON) return b.score - a.score;
    if (a.scopeRank !== b.scopeRank) return a.scopeRank - b.scopeRank;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.index - b.index;
  });

  return scored.map((s) => ({ entry: s.entry, score: s.score }));
}
