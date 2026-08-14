import { describe, it, expect } from 'vitest';
import {
  selectDiverse,
  rankLessons,
  MMR_LAMBDA,
  SCORE_EPSILON,
} from './lesson-rank.js';
import type { RankedLesson, RankableLesson } from './lesson-rank.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

/** Build a RankedLesson directly from entry + score — no rankLessons call. */
function ranked<T extends RankableLesson>(entry: T, score: number): RankedLesson<T> {
  return { entry, score };
}

// ── jaccardSimilarity unit tests (via selectDiverse behavior) ─────────────────
//
// jaccardSimilarity is private; its contract is tested through selectDiverse.
// AC-2: identical token sets → sim=1 (MMR penalty = 1−λ = 0.3, so distinct wins);
//        disjoint sets → sim<1; both-empty → sim=0.

describe('selectDiverse: jaccardSimilarity semantics (AC-2)', () => {
  // Two entries with IDENTICAL value text — after the first is selected, the
  // second should score a full (1−λ)=0.3 MMR penalty and lose to a distinct entry.
  it('identical token sets produce maximum MMR penalty (sim=1)', () => {
    const identical = 'caching timeout retry';
    const a = ranked({ scope: 'g', key: 'a', value: identical }, 0.9);
    const b = ranked({ scope: 'g', key: 'b', value: identical }, 0.8);
    const distinct = ranked({ scope: 'g', key: 'c', value: 'database migration schema' }, 0.75);
    // Raw rank order: a > b > c. After selecting a, MMR(b) = 0.7*0.8 - 0.3*1 = 0.56-0.3 = 0.26.
    // MMR(c) = 0.7*0.75 - 0.3*sim(c,a) = 0.525 - 0.3*0 = 0.525. So c wins over b.
    // Mental revert: removing the MMR diversity term (lambda=1) makes order a,b,c — no c promotion.
    const result = selectDiverse([a, b, distinct], 2);
    expect(result.map((r) => r.entry.key)).toEqual(['a', 'c']);
  });

  it('disjoint token sets produce zero MMR penalty (sim<1)', () => {
    // If two entries share no tokens, sim=0 and MMR(candidate) = λ*score (no penalty).
    const x = ranked({ scope: 'g', key: 'x', value: 'alpha beta gamma' }, 0.9);
    const y = ranked({ scope: 'g', key: 'y', value: 'delta epsilon zeta' }, 0.8);
    // After selecting x, MMR(y) = 0.7*0.8 - 0.3*0 = 0.56. y wins normally.
    const result = selectDiverse([x, y], 2);
    expect(result.map((r) => r.entry.key)).toEqual(['x', 'y']);
  });

  it('both-empty value → sim=0, no penalty (AC-2: both-empty → 0)', () => {
    // Empty values produce sim=0 between any pair, so order follows MMR with no penalty.
    const p = ranked({ scope: 'g', key: 'p', value: '' }, 0.9);
    const q = ranked({ scope: 'g', key: 'q', value: '' }, 0.8);
    const result = selectDiverse([p, q], 2);
    // No penalty — order equals raw rank (p, then q).
    expect(result.map((r) => r.entry.key)).toEqual(['p', 'q']);
  });
});

// ── selectDiverse core behavior (AC-1) ────────────────────────────────────────

describe('selectDiverse: MMR objective and core behavior (AC-1)', () => {
  // AC-10 (PRIMARY): near-dup HIGH-score lessons + one distinct lesson → the
  // real selectDiverse top-K includes the distinct one over a 2nd near-duplicate.
  //
  // Mental revert: removing the diversity term (lambda=1.0) returns the raw
  // rank order [A,B,C] and the distinct lesson D does NOT appear in top-3.
  // Setting lambda=1.0 here would flip this test red — the assertion that
  // mmrOrder contains 'D' would fail because D's score is lower than C's.
  it('AC-10: distinct lesson promotes over 2nd near-duplicate in real selectDiverse (revert-flips-red)', () => {
    // Three near-duplicates (A, B, C) share "caching timeout retry" vocabulary;
    // D has distinct "database schema migration" vocabulary.
    // Scores set directly on RankedLesson inputs to avoid 4-factor scorer interactions.
    // All four are pre-scored: A highest, B second, C third, D fourth.
    const A = ranked({ scope: 'g', key: 'A', value: 'caching timeout retry exponential backoff caching' }, 0.95);
    const B = ranked({ scope: 'g', key: 'B', value: 'caching timeout retry exponential strategy caching' }, 0.90);
    const C = ranked({ scope: 'g', key: 'C', value: 'caching retry timeout backoff pattern caching retry' }, 0.85);
    const D = ranked({ scope: 'g', key: 'D', value: 'database schema migration rollback strategy index' }, 0.80);

    const result = selectDiverse([A, B, C, D], 3);
    const keys = result.map((r) => r.entry.key);

    // A is always first (seeds the selection — highest score).
    expect(keys[0]).toBe('A');
    // D (distinct) must appear in top-3 over the 3rd near-dup C.
    // Mental revert: lambda=1.0 → order [A,B,C], D absent. That test would fail here.
    expect(keys).toContain('D');
    expect(keys).not.toContain('C');
  });

  it('honors k — returns exactly k entries (or fewer if input is smaller)', () => {
    const entries = [
      ranked({ scope: 'g', key: '1', value: 'alpha' }, 0.9),
      ranked({ scope: 'g', key: '2', value: 'beta' }, 0.8),
      ranked({ scope: 'g', key: '3', value: 'gamma' }, 0.7),
    ];
    expect(selectDiverse(entries, 2)).toHaveLength(2);
    expect(selectDiverse(entries, 5)).toHaveLength(3); // k > n → return all
  });

  it('reuses input scores (not recomputed) for the relevance term', () => {
    // Scores are taken directly from the RankedLesson input — if they were
    // recomputed from the entry fields the test would need to supply all scorer
    // inputs. Here we supply only score to prove the interface uses input scores.
    const a = ranked({ scope: 'g', key: 'a', value: 'x y z' }, 0.95);
    const b = ranked({ scope: 'g', key: 'b', value: 'x y z' }, 0.5);
    const c = ranked({ scope: 'g', key: 'c', value: 'p q r' }, 0.6);
    // After selecting a, MMR(b) = 0.7*0.5 - 0.3*1 = 0.05.
    // MMR(c) = 0.7*0.6 - 0.3*0 = 0.42. c wins.
    const result = selectDiverse([a, b, c], 2);
    expect(result.map((r) => r.entry.key)).toEqual(['a', 'c']);
  });

  it('first-wins tie-break: equal MMR scores resolve by input order', () => {
    // Three entries with IDENTICAL score AND identical value. After x seeds the
    // selection, y and z have the SAME MMR objective (same score, same sim to x),
    // so this is a genuine tie between two remaining candidates — not the sole
    // survivor. First-wins must pick y (index 1) over z (index 2) purely on input
    // order. A `>=` (last-wins) comparator would flip this to z and fail.
    const x = ranked({ scope: 'g', key: 'x', value: 'unique distinct content here' }, 0.8);
    const y = ranked({ scope: 'g', key: 'y', value: 'unique distinct content here' }, 0.8);
    const z = ranked({ scope: 'g', key: 'z', value: 'unique distinct content here' }, 0.8);
    // Seed is x (index 0). Next pick: MMR(y) = MMR(z) = 0.7*0.8 - 0.3*1 = 0.26.
    // The tie breaks to y because it appears first in the input.
    const result = selectDiverse([x, y, z], 2);
    expect(result[0].entry.key).toBe('x'); // seeded first
    expect(result[1].entry.key).toBe('y'); // wins the tie over z on input order
  });

  it('degenerate inputs: empty array returns []', () => {
    expect(selectDiverse([], 3)).toEqual([]);
  });

  it('degenerate inputs: k=0 returns []', () => {
    const e = [ranked({ scope: 'g', key: 'k', value: 'test' }, 0.9)];
    expect(selectDiverse(e, 0)).toEqual([]);
  });

  it('k=1 returns only the highest-scored entry (MMR seed)', () => {
    const entries = [
      ranked({ scope: 'g', key: 'a', value: 'alpha beta' }, 0.9),
      ranked({ scope: 'g', key: 'b', value: 'gamma delta' }, 0.8),
    ];
    const result = selectDiverse(entries, 1);
    expect(result).toHaveLength(1);
    expect(result[0].entry.key).toBe('a');
  });

  it('custom lambda=1 degenerates to raw-rank order (no diversity)', () => {
    // With lambda=1, the MMR term is λ·score - 0·sim = score. Diversity is ignored.
    // Mental revert: the AC-10 test above uses default lambda; setting lambda=1
    // there would flip it red.
    const A = ranked({ scope: 'g', key: 'A', value: 'caching timeout retry' }, 0.95);
    const B = ranked({ scope: 'g', key: 'B', value: 'caching timeout retry' }, 0.90);
    const C = ranked({ scope: 'g', key: 'C', value: 'database schema migration' }, 0.80);
    const result = selectDiverse([A, B, C], 3, { lambda: 1.0 });
    expect(result.map((r) => r.entry.key)).toEqual(['A', 'B', 'C']);
  });
});

// ── MMR_LAMBDA constant (AC-3) ─────────────────────────────────────────────────

describe('MMR_LAMBDA constant (AC-3)', () => {
  it('is exported and equals 0.7', () => {
    expect(MMR_LAMBDA).toBe(0.7);
  });
});

// ── Integration: real rankLessons output → selectDiverse (AC-1) ───────────────

describe('selectDiverse: integration with real rankLessons output (AC-1)', () => {
  it('operates on rankLessons output without recomputing scores', () => {
    // Four lessons: three near-dups (same "authentication token session" vocab)
    // plus one distinct ("network latency bandwidth throughput"). Scores driven
    // by recency. MMR should surface the distinct one over the 3rd near-dup.
    // Isolation: outcome:1 on all four (cold-start prior = 0.5 would add noise);
    // salience isolated by zeroing the weight; relevance=1 on all (FTS matched).
    const fixtures = [
      { scope: 'r', key: 'nd1', updatedAt: daysAgo(1), seenCount: 0, relevance: 1, outcome: 1, value: 'authentication token session refresh oauth authentication token' },
      { scope: 'r', key: 'nd2', updatedAt: daysAgo(2), seenCount: 0, relevance: 1, outcome: 1, value: 'authentication token session refresh strategy oauth token session' },
      { scope: 'r', key: 'nd3', updatedAt: daysAgo(3), seenCount: 0, relevance: 1, outcome: 1, value: 'authentication token session refresh pattern oauth authentication' },
      { scope: 'r', key: 'di',  updatedAt: daysAgo(4), seenCount: 0, relevance: 1, outcome: 1, value: 'network latency bandwidth throughput optimization tcp connection' },
    ];
    // Use salience:0 to isolate recency+relevance+outcome as ranking signals.
    const weights = { recency: 1, salience: 0, relevance: 1, outcome: 1 };
    const ranked2 = rankLessons(fixtures, { now: NOW, weights });
    const diverse = selectDiverse(ranked2, 3);
    const keys = diverse.map((r) => r.entry.key);

    // nd1 is always first (most recent → highest score seeds selection).
    expect(keys[0]).toBe('nd1');
    // The distinct lesson must appear in top-3.
    expect(keys).toContain('di');
    // nd3 (lowest raw score among near-dups) must NOT appear — displaced by di.
    expect(keys).not.toContain('nd3');
  });
});

// ── Scope precedence survives MMR for near-equal scores (BLOCKING 2) ───────────
//
// The MMR objective quantises `score` onto the SCORE_EPSILON grid before using
// it — the same grid `rankLessons` buckets on. So two scores within
// SCORE_EPSILON are equal to MMR, and the input order (which `rankLessons` has
// already sorted by scope precedence, then key) decides between them. Comparing
// the RAW score would let a sub-epsilon float difference override precedence.

describe('selectDiverse: scope precedence survives MMR for near-equal scores (BLOCKING 2)', () => {
  it('keeps the higher-precedence scope first when raw scores differ by < SCORE_EPSILON', () => {
    // hi (higher precedence) has a raw score a hair BELOW lo's — the lower-
    // precedence row. The gap is a fraction of SCORE_EPSILON, so both land in the
    // same quantisation bucket. Distinct values → zero Jaccard penalty, so only
    // the relevance term drives selection: the test isolates the score comparison.
    const hi = ranked({ scope: 'global', key: 'k', value: 'alpha beta gamma' }, 0.5);
    const lo = ranked({ scope: 'repo', key: 'k', value: 'delta epsilon zeta' }, 0.5 + SCORE_EPSILON / 4);

    // `rankLessons` (via the real pipeline elsewhere) would order [hi, lo]: same
    // bucket, then scope precedence puts `global` first. Feed that order in.
    const result = selectDiverse([hi, lo], 2);
    const scopes = result.map((r) => r.entry.scope);

    // Quantised: hi seeds first (tie → input order), lo follows → [global, repo].
    // With the RAW score bug, lo (0.5 + ε/4 > 0.5) would seed first → [repo, global].
    expect(scopes).toEqual(['global', 'repo']);
  });

  it('preserves rankLessons scope-precedence order end-to-end through MMR', () => {
    // Two rows scored identically by every factor EXCEPT scope; near-identical
    // timestamps put their raw scores within SCORE_EPSILON. `rankLessons` orders
    // them by the explicit scopeOrder; MMR must not reshuffle that.
    const fixtures = [
      { scope: 'repo', key: 'k', updatedAt: daysAgo(1), seenCount: 0, relevance: 1, outcome: 1, value: 'network latency bandwidth throughput' },
      { scope: 'global', key: 'k', updatedAt: daysAgo(1), seenCount: 0, relevance: 1, outcome: 1, value: 'authentication token session refresh' },
    ];
    // global outranks repo despite repo appearing first in the input.
    const rankedRows = rankLessons(fixtures, { now: NOW, scopeOrder: ['global', 'repo'] });
    expect(rankedRows.map((r) => r.entry.scope)).toEqual(['global', 'repo']);

    const diverse = selectDiverse(rankedRows, 2);
    expect(diverse.map((r) => r.entry.scope)).toEqual(['global', 'repo']);
  });
});
