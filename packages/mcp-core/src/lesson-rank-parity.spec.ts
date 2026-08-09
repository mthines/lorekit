import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  rankLessons as rankTs,
  scoreLesson as scoreTs,
  recencyFactor as recencyTs,
  salienceFactor as salienceTs,
  RECENCY_HALF_LIFE_DAYS as HALF_LIFE_TS,
  DEFAULT_RANK_WEIGHTS as WEIGHTS_TS,
  SCORE_EPSILON as EPSILON_TS,
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
  rankLessons: (entries: unknown[], opts?: Record<string, unknown>) => { key?: string }[];
  scoreLesson: (entry: unknown, opts?: Record<string, unknown>) => number;
  recencyFactor: (updatedAt: unknown, now: unknown, halfLifeDays?: number) => number;
  salienceFactor: (seen: unknown, max: unknown) => number;
  RECENCY_HALF_LIFE_DAYS: number;
  DEFAULT_RANK_WEIGHTS: { recency: number; salience: number; relevance: number };
  SCORE_EPSILON: number;
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
      { now: NOW, weights: { recency: 0, salience: 0, relevance: 1 } },
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
  const relevanceOnly = { recency: 0, salience: 0, relevance: 1 };

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
