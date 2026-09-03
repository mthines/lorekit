import { describe, expect, it } from 'vitest';
import {
  BROAD_REACH_DELIVERIES,
  CHOSEN_PULL_THROUGH,
  LESSON_UTILITY_META,
  MIN_AGE_DAYS_TO_JUDGE,
  MIN_DELIVERIES_TO_JUDGE,
  formatPerDay,
  formatPullThrough,
  lessonUtility,
  type LessonUtility,
} from './lesson-utility';

const NOW = new Date('2026-09-03T12:00:00Z');

/** A lesson `days` old with the given counters. */
function lesson(days: number, read_count: number, opened_count: number) {
  return {
    created_at: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
    read_count,
    opened_count,
  };
}

/**
 * The verdict, or a failed expectation. Every case below supplies both
 * counters, so a null here is a bug in the module rather than something each
 * assertion should have to narrow past.
 */
function verdictFor(input: Parameters<typeof lessonUtility>[0]) {
  const verdict = lessonUtility(input, NOW);
  expect(verdict).not.toBeNull();
  return verdict as NonNullable<ReturnType<typeof lessonUtility>>;
}

describe('lessonUtility', () => {
  it('returns null when the backend supplied no counters', () => {
    // Not the same answer as "unproven": a pre-00103 backend cannot be judged
    // at all, and a fabricated 0/0 verdict would read as "dormant".
    expect(lessonUtility({ created_at: NOW.toISOString() }, NOW)).toBeNull();
    expect(lessonUtility({ created_at: NOW.toISOString(), read_count: 5 }, NOW)).toBeNull();
    expect(lessonUtility({ created_at: NOW.toISOString(), opened_count: 5 }, NOW)).toBeNull();
  });

  it('separates a brand-new lesson from a dead one', () => {
    // The defect this whole verdict exists to fix: today both render identically.
    expect(verdictFor(lesson(2, 10, 0)).utility).toBe('unproven');
    expect(verdictFor(lesson(400, 1_417, 0)).utility).toBe('noise-tax');
  });

  it('withholds a verdict below either evidence floor, and gives one above both', () => {
    // Young but heavily delivered.
    expect(verdictFor(lesson(MIN_AGE_DAYS_TO_JUDGE - 1, 5_000, 0)).utility).toBe('unproven');
    // Old but barely delivered — a 1-of-1 open would otherwise score 100%.
    expect(verdictFor(lesson(365, MIN_DELIVERIES_TO_JUDGE - 1, 1)).utility).toBe('unproven');
    // Both floors cleared.
    expect(verdictFor(lesson(MIN_AGE_DAYS_TO_JUDGE, MIN_DELIVERIES_TO_JUDGE, 0)).utility)
      .not.toBe('unproven');
  });

  it('places each quadrant of the delivered x chosen grid', () => {
    const broad = BROAD_REACH_DELIVERIES;
    const narrow = BROAD_REACH_DELIVERIES - 1;
    const chosenOf = (n: number) => Math.ceil(n * CHOSEN_PULL_THROUGH);

    expect(verdictFor(lesson(90, broad, chosenOf(broad))).utility).toBe('load-bearing');
    expect(verdictFor(lesson(90, narrow, chosenOf(narrow))).utility).toBe('specialist');
    expect(verdictFor(lesson(90, broad, 0)).utility).toBe('noise-tax');
    expect(verdictFor(lesson(90, narrow, 0)).utility).toBe('dormant');
  });

  it('ranks a narrow, well-used lesson above a broad, ignored one', () => {
    // The confound the ratio exists to remove. By `read_count` alone the global
    // lesson wins by 400x; by pull-through the branch lesson wins by 400x.
    const global = verdictFor(lesson(90, 1_200, 2));
    const branch = verdictFor(lesson(90, 300, 100));
    expect(global.delivered).toBeGreaterThan(branch.delivered);
    expect(branch.pullThrough ?? 0).toBeGreaterThan(global.pullThrough ?? 0);
    expect(global.utility).toBe('noise-tax');
    expect(branch.utility).toBe('load-bearing');
  });

  it('reports pull-through as null rather than 0 when nothing was ever delivered', () => {
    // 0/0 is not "never chosen" — it is "never offered", and dividing would
    // report a rate the lesson never had the chance to earn.
    const verdict = verdictFor(lesson(365, 0, 0));
    expect(verdict.pullThrough).toBeNull();
    expect(verdict.utility).toBe('unproven');
  });

  it('does not divide by a fraction of a day for a lesson created moments ago', () => {
    const verdict = verdictFor(lesson(0, 4, 0));
    expect(verdict.deliveredPerDay).toBe(4);
    expect(Number.isFinite(verdict.deliveredPerDay)).toBe(true);
  });

  it('survives an unparseable created_at instead of reporting NaN', () => {
    const verdict = verdictFor({ created_at: 'not-a-date', read_count: 500, opened_count: 0 });
    expect(verdict.utility).toBe('unproven');
    expect(Number.isNaN(verdict.deliveredPerDay)).toBe(false);
  });

  it('gives every verdict an action and a detail line', () => {
    const cases = [lesson(2, 10, 0), lesson(90, 500, 50), lesson(90, 50, 10), lesson(90, 500, 0), lesson(90, 50, 0)];
    for (const c of cases) {
      const v = verdictFor(c);
      expect(v.action).not.toBe('');
      expect(v.detail).not.toBe('');
    }
  });
});

describe('LESSON_UTILITY_META', () => {
  it('covers every verdict', () => {
    const verdicts: LessonUtility[] = ['load-bearing', 'specialist', 'noise-tax', 'dormant', 'unproven'];
    for (const v of verdicts) {
      expect(LESSON_UTILITY_META[v].label).not.toBe('');
      expect(LESSON_UTILITY_META[v].description).not.toBe('');
    }
    expect(Object.keys(LESSON_UTILITY_META).sort()).toEqual([...verdicts].sort());
  });
});

describe('formatting', () => {
  it('keeps a sub-1% rate legible instead of rounding it to 0.0%', () => {
    expect(formatPullThrough(0.0015)).toBe('0.15%');
    expect(formatPullThrough(0.108)).toBe('10.8%');
    expect(formatPullThrough(0)).toBe('0.0%');
  });

  it('drops the decimal once a delivery rate is large', () => {
    expect(formatPerDay(4.2)).toBe('4.2/day');
    expect(formatPerDay(210.4)).toBe('210/day');
  });
});
