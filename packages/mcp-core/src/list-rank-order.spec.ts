import { describe, it, expect } from 'vitest';
import { rankLessons } from './lesson-rank.js';

/**
 * AC-3: When ranking is applied over a candidate set whose recency order and
 * rank order differ (an older row with a higher seen_count), the real edge
 * rankLessons order shall differ from the raw updated_at desc order.
 *
 * This spec exercises the REAL edge `rankLessons` (imported from
 * `lesson-rank.ts`, the file mirrored into `supabase/functions/_shared/`).
 * It does NOT re-encode an expected list — the assertion is structural:
 * "ranked order != recency order on this fixture".
 *
 * SCOPE — read this before trusting the spec as a gate. It exercises
 * `rankLessons` only, which this PR does not modify. It therefore proves the
 * PREMISE the ranked `toolList` branch rests on — that ranked order really
 * does diverge from recency order on a realistic fixture — and it goes red if
 * `rankLessons` ever loses that property or the fixture stops creating the
 * divergence. It does NOT execute the edge `toolList` ranked branch, so
 * reverting that branch (dropping `order=rank` from `supabase/functions/mcp/
 * tools.ts`) would leave this spec green. Coverage of the branch itself lives
 * with the edge function, not here.
 */

describe('toolList order=rank: ranked order diverges from recency order', () => {
  const NOW = Date.parse('2026-08-01T00:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

  /**
   * A fixture designed so recency order and rank order MUST differ:
   * - 'newer-low'  is the freshest (0 days old) but has seen_count = 0 → low salience.
   * - 'older-high' is older (60 days old) but has seen_count = 9 → high salience.
   *
   * At DEFAULT_RANK_WEIGHTS (recency:1, salience:1, relevance:1 → equal thirds),
   * the salience boost of 'older-high' (seen_count 9 >> 0) outweighs its
   * recency penalty vs 'newer-low' at 60 days old (still above 0 due to
   * finite half-life), so rankLessons places 'older-high' first.
   */
  const candidates = [
    { id: '1', key: 'newer-low', scope: 'global', value: 'v', tags: [], updated_at: daysAgo(0), seen_count: 0 },
    { id: '2', key: 'older-high', scope: 'global', value: 'v', tags: [], updated_at: daysAgo(60), seen_count: 9 },
  ];

  it('recency order (input order) puts newer-low first', () => {
    // Sanity-check: the input is already in updated_at desc order.
    expect(candidates[0].key).toBe('newer-low');
    expect(candidates[1].key).toBe('older-high');
  });

  it('rank order (real rankLessons) puts older-high first — proving ranked != recency', () => {
    const ranked = rankLessons(candidates, { now: NOW });
    expect(ranked.length).toBe(2);

    // The older-but-high-seen_count row must rank first. If this assertion
    // fails, either rankLessons changed semantics or the fixture no longer
    // creates the divergence (both are detectable regressions).
    expect(ranked[0].entry.key).toBe('older-high');
    expect(ranked[1].entry.key).toBe('newer-low');

    // Extra guard: scores confirm the ranking is meaningful, not a tie.
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('the ranked order differs from the updated_at desc order', () => {
    const recencyKeys = candidates.map((c) => c.key); // updated_at desc
    const rankedKeys = rankLessons(candidates, { now: NOW }).map((r) => r.entry.key);

    // This is the central AC-3 assertion: the two orderings must NOT be
    // identical. If `rankLessons` were reduced to a pass-through of its input,
    // both lists would read ['newer-low', 'older-high'] and this would fail.
    expect(rankedKeys).not.toEqual(recencyKeys);
  });
});
