import { describe, it, expect } from 'vitest';
import {
  normalizeLexicalRank,
  normalizeRelevance,
  scoreLesson,
  rankLessons,
  LEXICAL_RANK_SATURATION,
} from './lesson-rank.js';

/**
 * PINS THE ts_rank_cd → relevance MAPPING.
 *
 * `GET /memories/relevant` asks Postgres for `ts_rank_cd` (migration 00112) and
 * hands the raw, UNBOUNDED value to `normalizeLexicalRank` before the scorer
 * ever sees it. Every `score` the endpoint reports therefore depends on this
 * one function, and nothing else in the repo would notice if it changed: the
 * response would still validate, the parity spec would still pass (relevance is
 * supplied explicitly on both sides of it), and the only symptom would be that
 * the endpoint quietly started recommending different lessons.
 *
 * So the mapping is pinned by value, not merely by property. A deliberate
 * change to it has to come here and rewrite the numbers, which is exactly the
 * visibility the change deserves.
 */
describe('normalizeLexicalRank: the pinned mapping', () => {
  it('saturates at the schema-anchored default D weight', () => {
    // `memories.fts` applies no `setweight`, so every lexeme carries Postgres's
    // default D weight of 0.1 (migration 00001). Changing this constant is a
    // change to every score the endpoint reports.
    expect(LEXICAL_RANK_SATURATION).toBe(0.1);
  });

  it('maps a single-term cover onto the midpoint of the factor', () => {
    // r = 0.1 is one query lexeme in one cover — the weakest a real match can
    // be — and it reads 0.5, not 0.09.
    expect(normalizeLexicalRank(0.1)).toBeCloseTo(0.5, 12);
  });

  it('maps the rest of the plausible ts_rank_cd range by value', () => {
    expect(normalizeLexicalRank(0.2)).toBeCloseTo(2 / 3, 12);
    expect(normalizeLexicalRank(0.3)).toBeCloseTo(0.75, 12);
    expect(normalizeLexicalRank(0.5)).toBeCloseTo(5 / 6, 12);
    expect(normalizeLexicalRank(1)).toBeCloseTo(10 / 11, 12);
    expect(normalizeLexicalRank(10)).toBeCloseTo(100 / 101, 12);
  });

  it('is strictly increasing, so it can never reorder what Postgres ranked', () => {
    // The load-bearing property: the RPC cuts its candidate window by
    // `ts_rank_cd` desc, and this map must preserve that order or the window and
    // the scoring would disagree about which rows matched best.
    const ranks = [0.01, 0.05, 0.1, 0.11, 0.2, 0.37, 1, 2.5, 40];
    const mapped = ranks.map((r) => normalizeLexicalRank(r));
    for (let i = 1; i < mapped.length; i++) {
      expect(mapped[i]).toBeGreaterThan(mapped[i - 1]);
    }
  });

  it('stays inside [0,1) — asymptotic, never 1', () => {
    for (const r of [0.0001, 0.1, 1, 1e3, 1e9]) {
      const v = normalizeLexicalRank(r);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('scores absent, zero, negative and unreadable input at 0', () => {
    // The same answer `normalizeRelevance` gives, and for the same reason: no
    // evidence of a lexical match is not a weak match. A no-`q` request arrives
    // here as `null` on every row and must keep scoring exactly as it did
    // before relevance was graded.
    for (const bad of [null, undefined, 0, -1, -0.5, NaN, Infinity, -Infinity, '', 'lots', {}, []]) {
      expect(normalizeLexicalRank(bad)).toBe(0);
    }
    expect(normalizeLexicalRank(null)).toBe(normalizeRelevance(null));
  });

  it('reads a numeric string, because a driver may hand back a numeric as text', () => {
    expect(normalizeLexicalRank('0.1')).toBeCloseTo(0.5, 12);
  });

  it('falls back to the pinned saturation on an unusable override', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(normalizeLexicalRank(0.1, bad as number)).toBeCloseTo(0.5, 12);
    }
    // A usable override is honoured — the knob exists so a test can vary it.
    expect(normalizeLexicalRank(1, 1)).toBeCloseTo(0.5, 12);
  });

  it('is deterministic — the same input returns the same bits, every time', () => {
    const once = normalizeLexicalRank(0.37);
    for (let i = 0; i < 100; i++) expect(normalizeLexicalRank(0.37)).toBe(once);
  });
});

describe('graded relevance changes the ordering the endpoint produces', () => {
  const NOW = Date.parse('2026-09-01T00:00:00.000Z');
  const updatedAt = new Date(NOW - 86400000).toISOString();

  /** Two rows identical in every factor but how well they matched. */
  const twoTermVsOne = [
    // `ts_rank_cd` for a cover holding two query lexemes vs one.
    { scope: 'repo::a/b', key: 'one-term', value: 'x', seen_count: 3, updated_at: updatedAt, relevance: normalizeLexicalRank(0.1) },
    { scope: 'repo::a/b', key: 'two-terms', value: 'y', seen_count: 3, updated_at: updatedAt, relevance: normalizeLexicalRank(0.2) },
  ];

  it('a row matching two query terms outranks one matching a single term', () => {
    const ranked = rankLessons(twoTermVsOne, { now: NOW });
    expect(ranked.map((r) => r.entry.key)).toEqual(['two-terms', 'one-term']);
  });

  it('the binary form could not tell them apart — this is the regression', () => {
    // Before 00112 every matched row arrived with `relevance: 1`, so the two
    // rows above were identical in all four factors and only the key tiebreak
    // separated them. That is the ordering this PR exists to replace.
    const binary = twoTermVsOne.map((r) => ({ ...r, relevance: 1 }));
    const ranked = rankLessons(binary, { now: NOW });
    expect(ranked[0].score).toBe(ranked[1].score);
    expect(ranked.map((r) => r.entry.key)).toEqual(['one-term', 'two-terms']);
  });

  it('a weak match can now score below the old binary floor of 0.375', () => {
    // The `min_score` contract changes with grading. Under binary relevance a
    // matched row scored at least `(1 + 0.5) / 4 = 0.375` — the relevance term
    // at 1 and the outcome term at its cold-start prior — so any `min_score`
    // below that was a no-op. A faintly-matching, stale, unrecurring row now
    // falls under it, which is the whole point of grading.
    const weakAndStale = {
      scope: 'global',
      key: 'faint',
      value: 'z',
      seen_count: 1,
      updated_at: new Date(NOW - 365 * 86400000).toISOString(),
      relevance: normalizeLexicalRank(0.005),
    };
    expect(scoreLesson(weakAndStale, { now: NOW, maxSeenCount: 1 })).toBeLessThan(0.375);
  });
});
