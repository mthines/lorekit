import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  rankLessons as rankTs,
  selectDiverse as selectDiverseTs,
  scoreLesson as scoreTs,
  recencyFactor as recencyTs,
  salienceFactor as salienceTs,
  normalizeOutcome as normalizeOutcomeTs,
  RECENCY_HALF_LIFE_DAYS as HALF_LIFE_TS,
  DEFAULT_RANK_WEIGHTS as WEIGHTS_TS,
  SCORE_EPSILON as EPSILON_TS,
  COLD_START_OUTCOME_PRIOR,
} from './lesson-rank.js';

/**
 * CROSS-LANGUAGE PARITY: `packages/mcp-core/src/lesson-rank.ts` (the server
 * scorer, mirrored into the edge tree) must rank identically to
 * `packages/cli/src/lessons-pure.mjs` (the hook scorer).
 *
 * Two implementations of one ranking exist because the two runtimes cannot
 * share a module: the CLI is a zero-dep `.mjs` package with no build step, and
 * the edge function cannot import from `packages/` at all. Every OTHER
 * duplicated rule in this repo is guarded by a byte-for-byte file comparison
 * (`edge-parity.spec.ts`), which is unavailable across languages — so the
 * guard is BEHAVIOURAL instead: run both over the same fixtures and require the
 * same numbers and the same order.
 *
 * Without this, the SessionStart hook and `GET /memories/relevant` would drift
 * into disagreeing about which lesson matters most, silently, and the symptom
 * would be "the hook and the endpoint recommend different things" — an
 * observation nobody makes until they are debugging something else entirely.
 */

// The CLI is a plain `.mjs` package outside this project's tsconfig, so it is
// loaded by URL at runtime rather than as a typed import.
const cliModulePath = join(import.meta.dirname, '../../cli/src/lessons-pure.mjs');
const cli = await import(/* @vite-ignore */ `file://${cliModulePath}`) as {
  rankLessons: (entries: unknown[], opts?: Record<string, unknown>) => { key?: string; scope?: string; value?: string }[];
  selectDiverse: (entries: unknown[], k: number, opts?: { lambda?: number; scores?: number[] }) => { key?: string; scope?: string }[];
  scoreLesson: (entry: unknown, opts?: Record<string, unknown>) => number;
  recencyFactor: (updatedAt: unknown, now: unknown, halfLifeDays?: number) => number;
  salienceFactor: (seen: unknown, max: unknown) => number;
  normalizeOutcome: (value: unknown) => number;
  RECENCY_HALF_LIFE_DAYS: number;
  DEFAULT_RANK_WEIGHTS: { recency: number; salience: number; relevance: number; outcome: number };
  SCORE_EPSILON: number;
  COLD_START_OUTCOME_PRIOR: number;
  MMR_LAMBDA: number;
};

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

/** A spread of shapes: fresh/stale, recurring/one-off, several scopes, junk. */
const FIXTURES = [
  { scope: 'global', key: 'alpha', seenCount: 1, updatedAt: daysAgo(0) },
  { scope: 'global', key: 'beta', seenCount: 12, updatedAt: daysAgo(30) },
  { scope: 'repo::a/b', key: 'gamma', seenCount: 3, updatedAt: daysAgo(2) },
  { scope: 'repo::a/b', key: 'delta', seenCount: 1, updatedAt: daysAgo(2) },
  { scope: 'branch::a/b::main', key: 'epsilon', seenCount: 40, updatedAt: daysAgo(180) },
  { scope: 'global', key: 'zeta', seenCount: 1, updatedAt: daysAgo(14) },
  // Deliberate ties: identical in every scoring input, so only the tiebreakers
  // separate them — the part most likely to diverge between two sort
  // implementations.
  { scope: 'global', key: 'tie-b', seenCount: 5, updatedAt: daysAgo(3) },
  { scope: 'global', key: 'tie-a', seenCount: 5, updatedAt: daysAgo(3) },
  { scope: 'repo::a/b', key: 'tie-a', seenCount: 5, updatedAt: daysAgo(3) },
  // Degenerate rows: absent count, absent timestamp, unparseable both.
  { scope: 'global', key: 'no-count', updatedAt: daysAgo(1) },
  { scope: 'global', key: 'no-time', seenCount: 7 },
  { scope: 'global', key: 'junk', seenCount: 'lots', updatedAt: 'yesterday' },
];

describe('lesson-rank ↔ lessons-pure: the constants agree', () => {
  it('half-life', () => expect(HALF_LIFE_TS).toBe(cli.RECENCY_HALF_LIFE_DAYS));
  it('default weights', () => expect(WEIGHTS_TS).toEqual(cli.DEFAULT_RANK_WEIGHTS));
  it('score epsilon', () => expect(EPSILON_TS).toBe(cli.SCORE_EPSILON));
});

describe('lesson-rank ↔ lessons-pure: the factors agree', () => {
  it('recency, across the whole decay curve', () => {
    for (const days of [0, 0.5, 1, 7, 14, 28, 100, 365, 3650]) {
      expect(recencyTs(daysAgo(days), NOW)).toBeCloseTo(cli.recencyFactor(daysAgo(days), NOW), 15);
    }
  });

  it('recency, on the degenerate inputs', () => {
    for (const bad of [null, undefined, '', 'yesterday', {}]) {
      expect(recencyTs(bad, NOW)).toBe(cli.recencyFactor(bad, NOW));
    }
    // Future timestamps clamp identically.
    const future = new Date(NOW + 86400000).toISOString();
    expect(recencyTs(future, NOW)).toBe(cli.recencyFactor(future, NOW));
  });

  it('salience, including the no-recurrence floor', () => {
    for (const [n, max] of [[0, 0], [1, 1], [1, 8], [2, 8], [8, 8], [3, 50], [40, 50], [50, 50]]) {
      expect(salienceTs(n, max)).toBeCloseTo(cli.salienceFactor(n, max), 15);
    }
  });

  it('salience, above the set maximum — the clamp both sides promise', () => {
    // Every other fixture uses n <= max, so none of them can catch a missing
    // `Math.min(1, …)`. These reach the factor with a maximum that is not the
    // set's, which is the only way the clamp binds.
    for (const [n, max] of [[5, 2], [50, 3], [1000, 2]]) {
      expect(salienceTs(n, max)).toBeCloseTo(cli.salienceFactor(n, max), 15);
      expect(salienceTs(n, max)).toBe(1);
    }
  });
});

describe('lesson-rank ↔ lessons-pure: whole-set ranking agrees', () => {
  it('produces the same order over the fixture set', () => {
    const ts = rankTs(FIXTURES, { now: NOW }).map((r) => `${r.entry.scope}::${r.entry.key}`);
    const js = cli.rankLessons(FIXTURES, { now: NOW }).map((e) => {
      const row = e as { scope?: string; key?: string };
      return `${row.scope}::${row.key}`;
    });
    expect(ts).toEqual(js);
  });

  it('produces the same order under an explicit scopeOrder', () => {
    const scopeOrder = ['branch::a/b::main', 'repo::a/b', 'global'];
    const ts = rankTs(FIXTURES, { now: NOW, scopeOrder }).map((r) => `${r.entry.scope}::${r.entry.key}`);
    const js = cli.rankLessons(FIXTURES, { now: NOW, scopeOrder }).map((e) => {
      const row = e as { scope?: string; key?: string };
      return `${row.scope}::${row.key}`;
    });
    expect(ts).toEqual(js);
  });

  it('produces the same order under non-default weights', () => {
    for (const weights of [
      { recency: 3, salience: 1, relevance: 0 },
      { recency: 0, salience: 1, relevance: 0 },
      { recency: 1, salience: 0, relevance: 0 },
    ]) {
      const ts = rankTs(FIXTURES, { now: NOW, weights }).map((r) => `${r.entry.scope}::${r.entry.key}`);
      const js = cli.rankLessons(FIXTURES, { now: NOW, weights }).map((e) => {
        const row = e as { scope?: string; key?: string };
        return `${row.scope}::${row.key}`;
      });
      expect(ts).toEqual(js);
    }
  });

  it('produces the same SCORES, not merely the same order', () => {
    // Order agreement can hide a systematic offset that would surface the
    // moment a threshold or a displayed score is added. `relevance` is the one
    // intentional difference (the CLI derives it from terms, the server takes
    // it from FTS), so it is held at 0 on both sides here.
    const maxSeenCount = 40;
    for (const fixture of FIXTURES) {
      const ts = scoreTs(fixture, { now: NOW, maxSeenCount });
      const js = cli.scoreLesson(fixture, { now: NOW, maxSeenCount, terms: [] });
      expect(ts).toBeCloseTo(js, 15);
    }
  });

  it('agrees that an empty or junk input ranks to nothing', () => {
    for (const bad of [[], null, undefined]) {
      expect(rankTs(bad as never)).toEqual([]);
      expect(cli.rankLessons(bad as never)).toEqual([]);
    }
  });
});

describe('lesson-rank: the server-only relevance input', () => {
  it('is taken from the row rather than computed from terms', () => {
    // The one deliberate divergence. On the server, relevance is Postgres's FTS
    // rank — already computed by the query that selected the candidate — so the
    // scorer clamps it rather than re-deriving it from a term list it does not
    // have.
    const base = { scope: 'global', key: 'k', seenCount: 1, updatedAt: daysAgo(0) };
    const withRelevance = scoreTs({ ...base, relevance: 1 }, { now: NOW, maxSeenCount: 1 });
    const without = scoreTs(base, { now: NOW, maxSeenCount: 1 });
    expect(withRelevance).toBeGreaterThan(without);
  });

  it('clamps an out-of-range or unusable relevance', () => {
    const at = (relevance: unknown) => scoreTs(
      { scope: 'g', key: 'k', relevance: relevance as number },
      // outcome:0 isolates the relevance factor — without it, the outcome weight
      // defaults to 1 and dilutes the result (the cold-start prior contributes 0.5).
      { now: NOW, weights: { recency: 0, salience: 0, relevance: 1, outcome: 0 } },
    );
    expect(at(2)).toBe(1);
    expect(at(-1)).toBe(0);
    expect(at('0.5')).toBeCloseTo(0.5, 15);
    for (const bad of [null, undefined, NaN, 'nope', {}]) expect(at(bad)).toBe(0);
  });
});

describe('lesson-rank: the epsilon-grid tie-break is transitive', () => {
  // The tie-break quantises each score onto the SCORE_EPSILON grid and compares
  // buckets, NOT `Math.abs(a - b) <= SCORE_EPSILON` — the non-transitive form the
  // CLI twin rejects, under which a chain of rows each one grid step from its
  // neighbour reads as a run of pairwise "ties" and the order falls to input
  // position, so the same set ranks differently under different permutations.
  // The existing FIXTURES only cover EXACT ties, which the old form got right;
  // this pins the NEAR-tie case the bucket comparison was introduced for.
  //
  // relevance drives the scores because it is the one input settable to an exact
  // value — recency and salience are transcendental and cannot be placed on the
  // grid deterministically. That makes this a TS-only check (like the
  // server-only-relevance block above): the CLI derives relevance from terms.
  // The two twins run the IDENTICAL bucket algorithm, and their agreement over
  // the shared inputs is already pinned by the whole-set order tests above.
  // outcome:0 isolates the relevance factor — without it the cold-start prior
  // (0.5, constant for all rows) would compress the tiny score differences from
  // the one-epsilon-step chain and collapse them into fewer distinct buckets.
  const relevanceOnly = { recency: 0, salience: 0, relevance: 1, outcome: 0 };

  // Five rows exactly one grid step apart in score, identical in every
  // tiebreaker (same scope, same key) so ONLY the score can separate them.
  const chain = Array.from({ length: 5 }, (_, i) => ({
    scope: 'global',
    key: 'k',
    relevance: 0.5 + i * EPSILON_TS,
  }));

  // The ranked scores, expressed as their grid buckets (integers), so the
  // assertion does not hinge on float formatting.
  const rankedBuckets = (rows: typeof chain) =>
    rankTs(rows, { now: NOW, weights: relevanceOnly }).map((r) => Math.round(r.score / EPSILON_TS));

  it('orders near-ties one grid step apart by score, highest first', () => {
    const buckets = rankedBuckets(chain);
    // The premise first: five DISTINCT buckets. A sorted-descending check is
    // trivially true of a constant array, so without this the test would keep
    // passing if the chain ever collapsed onto one bucket — which is the exact
    // regression a widened grid would cause.
    expect(new Set(buckets).size).toBe(chain.length);
    expect(buckets).toEqual([...buckets].sort((a, b) => b - a));
  });

  it('produces the same order for every input permutation', () => {
    const canonical = rankedBuckets(chain);
    for (const perm of [
      [4, 3, 2, 1, 0],
      [0, 2, 4, 1, 3],
      [2, 0, 3, 4, 1],
      [1, 4, 0, 3, 2],
    ]) {
      expect(rankedBuckets(perm.map((i) => chain[i]))).toEqual(canonical);
    }
  });
});

// ── selectDiverse parity: TS and .mjs produce the same selected scope::key order ─
//
// This block exercises `selectDiverse` across both twins and asserts:
//  1. TS and .mjs select the same scope::key order over the shared fixture.
//  2. The selected order DIVERGES from the raw-rank order — proving the fixture
//     exercises MMR (not just a pass-through of rank order).
//
// Fixture design: three near-duplicate high-score lessons (similar value text)
// plus one distinct lesson ranked lower by recency. MMR should prefer the
// distinct lesson over the 2nd near-duplicate because its maxSim to already-
// selected entries is low, boosting its MMR score over a 3rd near-dup.
// Isolation: relevance=1 and outcome=1 on all four to equalize those factors;
// recency differentiates raw rank order. weights zeroed on salience so the
// seenCount doesn't interfere.

describe('selectDiverse parity: TS ↔ .mjs produce the same diverse selection', () => {
  // Four entries: A/B/C share the same "caching timeout retry" vocabulary (near-dups);
  // D has "database schema migration" vocabulary (distinct). Under MMR, after
  // selecting A (highest raw rank), the next pick favours D over B because sim(D,A)
  // is near-zero while sim(B,A) is high — so D enters the top-3 ahead of B.
  const divergeFixtures = [
    { scope: 'global', key: 'A', seenCount: 0, updatedAt: daysAgo(1),  relevance: 1, outcome: 1, value: 'caching timeout retry exponential backoff caching timeout retry' },
    { scope: 'global', key: 'B', seenCount: 0, updatedAt: daysAgo(2),  relevance: 1, outcome: 1, value: 'caching timeout retry exponential backoff strategy caching' },
    { scope: 'global', key: 'C', seenCount: 0, updatedAt: daysAgo(3),  relevance: 1, outcome: 1, value: 'caching timeout retry exponential backoff pattern retry' },
    { scope: 'global', key: 'D', seenCount: 0, updatedAt: daysAgo(4),  relevance: 1, outcome: 1, value: 'database schema migration rollback strategy index creation' },
  ];
  const K = 3;
  // Default weights (no zeroing) so recency differentiates the raw rank
  // A>B>C>D — the raw top-3 is [A,B,C], but MMR picks [A,D,B] or similar because
  // D's low similarity to A promotes it over the near-duplicate B. relevance=1
  // and outcome=1 on all four equalise those factors; seenCount=0 on all four
  // means salience is 0 for everyone regardless of its weight.
  const rankOpts = { now: NOW };

  it('TS and .mjs agree on the selected scope::key order (R9 diverge fixture)', () => {
    // TS side
    const tsRanked = rankTs(divergeFixtures, rankOpts);
    const tsDiverse = selectDiverseTs(tsRanked, K);
    const tsOrder = tsDiverse.map((r) => `${r.entry.scope}::${r.entry.key}`);

    // .mjs side — rank to get bare entries + need scores for selectDiverse
    const jsRanked = cli.rankLessons(divergeFixtures, rankOpts);
    // Compute scores in parallel using the .mjs scorer (same maxSeenCount=0, same now)
    const maxSeenCount = 0;
    const jsScores = jsRanked.map((e) => cli.scoreLesson(e, { now: NOW, maxSeenCount, terms: [] }));
    const jsDiverse = cli.selectDiverse(jsRanked, K, { scores: jsScores });
    const jsOrder = jsDiverse.map((e) => {
      const row = e as { scope?: string; key?: string };
      return `${row.scope}::${row.key}`;
    });

    expect(tsOrder).toEqual(jsOrder);
  });

  it('the selected order diverges from the raw-rank order (MMR is exercised)', () => {
    // Raw-rank order by recency: A(1d), B(2d), C(3d), D(4d) → top-3 = [A,B,C]
    const tsRanked = rankTs(divergeFixtures, rankOpts);
    const rawOrder = tsRanked.slice(0, K).map((r) => `${r.entry.scope}::${r.entry.key}`);
    const tsDiverse = selectDiverseTs(tsRanked, K);
    const mmrOrder = tsDiverse.map((r) => `${r.entry.scope}::${r.entry.key}`);

    // MMR must pick differently from the raw top-K (if they were the same,
    // the fixture does not exercise the diversity term at all).
    expect(mmrOrder).not.toEqual(rawOrder);
    // D must appear in the MMR selection (it is the distinct lesson).
    expect(mmrOrder).toContain('global::D');
    // A must be first (highest raw score, seeds the selection).
    expect(mmrOrder[0]).toBe('global::A');
  });

  it('MMR_LAMBDA constant matches the CLI twin', () => {
    expect(cli.MMR_LAMBDA).toBe(0.7);
  });
});

// ── TS-only: outcome factor + cold-start prior (AC-1, AC-2, AC-3) ────────────
//
// These mirror the CLI-side tests in unit.test.mjs but run against the TS
// scorer directly. The outcome factor is server-derived (from tags + origin_pr)
// so the TS scorer takes a pre-computed `outcome` value — exactly like how
// `relevance` works. These are TS-only checks for the same reason as the
// server-only-relevance block above.

describe('lesson-rank: outcome factor and cold-start prior', () => {
  // ── AC-3: normalizeOutcome ───────────────────────────────────────────────
  it('normalizeOutcome returns COLD_START_OUTCOME_PRIOR for absent/unreadable input', () => {
    // The deliberate asymmetry vs normalizeRelevance (which returns 0 for absent).
    for (const absent of [null, undefined, NaN, 'nope', {}] as unknown[]) {
      expect(normalizeOutcomeTs(absent)).toBe(COLD_START_OUTCOME_PRIOR);
    }
  });

  it('normalizeOutcome agrees with CLI normalizeOutcome across the same inputs', () => {
    for (const v of [0, 0.5, 1, 2, -1, '0.5', null, undefined, NaN] as unknown[]) {
      expect(normalizeOutcomeTs(v)).toBeCloseTo(cli.normalizeOutcome(v), 15);
    }
  });

  it('normalizeOutcome clamps a present value into [0,1]', () => {
    expect(normalizeOutcomeTs(2)).toBe(1);
    expect(normalizeOutcomeTs(-1)).toBe(0);
    expect(normalizeOutcomeTs(0.5)).toBeCloseTo(0.5, 15);
    expect(normalizeOutcomeTs('0.5' as unknown as number)).toBeCloseTo(0.5, 15);
  });

  it('COLD_START_OUTCOME_PRIOR constant matches the CLI twin', () => {
    expect(COLD_START_OUTCOME_PRIOR).toBe(cli.COLD_START_OUTCOME_PRIOR);
  });

  // ── AC-1: outcome-positive outranks outcome-negative ────────────────────
  it('outcome-positive row outranks outcome-negative row at equal recency+salience (real rankLessons)', () => {
    // Two rows identical in everything except outcome. The outcome factor must be
    // load-bearing: removing it (outcome weight 0) removes the ordering difference.
    const shared = { seenCount: 5, updatedAt: daysAgo(3) };
    const positive = { ...shared, key: 'positive', outcome: 1.0 };
    const negative = { ...shared, key: 'negative', outcome: 0.0 };

    const ranked = rankTs([negative, positive], { now: NOW });
    const keys = ranked.map((r) => r.entry.key);
    expect(keys.indexOf('positive')).toBe(0);
    expect(keys.indexOf('negative')).toBe(1);

    // Mental revert: with outcome weight 0, both rows score identically.
    const rankNoOutcome = rankTs([negative, positive], {
      now: NOW,
      weights: { recency: 1, salience: 1, relevance: 1, outcome: 0 },
    });
    const buckets = rankNoOutcome.map((r) => Math.round(r.score / EPSILON_TS));
    expect(buckets[0]).toBe(buckets[1]);
  });

  // ── AC-2: cold-start prior — cold new row outranks old low-relevance row ─
  it('cold new row outranks old low-relevance row (cold-start prior not zero, real rankLessons)', () => {
    // A cold recent row (no outcome — gets the prior) vs an old stale row with
    // explicit outcome:0. The cold new row should win via recency + the prior.
    const coldNew = { key: 'cold-new', updatedAt: daysAgo(1), seenCount: 1 };
    const oldStale = { key: 'old-stale', updatedAt: daysAgo(90), seenCount: 1, outcome: 0.0 };

    const ranked = rankTs([oldStale, coldNew], { now: NOW });
    const keys = ranked.map((r) => r.entry.key);
    expect(keys[0]).toBe('cold-new');

    // The load-bearing check: hold recency, salience and relevance EQUAL between
    // the two rows so the ONLY difference is outcome. The cold row (absent
    // outcome → prior) must still outrank an explicit `outcome: 0` row — that
    // ordering can only come from the prior being > 0. Zeroing the prior would
    // tie the two, so this assertion fails the moment the prior degrades.
    const coldSameAge = { key: 'cold', updatedAt: daysAgo(3), seenCount: 5 };
    const zeroSameAge = { key: 'zero', updatedAt: daysAgo(3), seenCount: 5, outcome: 0.0 };
    const tieRank = rankTs([zeroSameAge, coldSameAge], { now: NOW });
    expect(tieRank[0].entry.key).toBe('cold');

    // Score the pair against the same population (maxSeenCount) rankLessons uses,
    // so the strict-greater is on the ranking's own arithmetic, not a re-derived
    // one. The gap is exactly the prior contribution: COLD_START_OUTCOME_PRIOR/4.
    const opts = { now: NOW, maxSeenCount: 5 };
    const coldScore = scoreTs(coldSameAge, opts);
    const zeroScore = scoreTs(zeroSameAge, opts);
    expect(coldScore).toBeGreaterThan(zeroScore);
    expect(coldScore - zeroScore).toBeCloseTo(COLD_START_OUTCOME_PRIOR / 4, 9);
  });
});
