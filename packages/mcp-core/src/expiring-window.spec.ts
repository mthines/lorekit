import { describe, it, expect } from 'vitest';
import { ListMemoriesQuerySchema } from '@lorekit/schemas/memory';
import {
  expiringWindow,
  EXPIRING_WITHIN_DAYS_MIN,
  EXPIRING_WITHIN_DAYS_MAX,
} from './expiring-window.js';

/**
 * A frozen clock, so every expectation below is a literal rather than a
 * recomputation of the implementation's own arithmetic. Deliberately NOT
 * midnight: a bound that is only correct on day boundaries is a bug this suite
 * has to be able to see.
 */
const NOW = '2026-08-08T17:34:56.789Z';

describe('expiringWindow', () => {
  it('returns (now, now + days] as literal timestamps', () => {
    expect(expiringWindow(7, NOW)).toEqual({
      after: '2026-08-08T17:34:56.789Z',
      onOrBefore: '2026-08-15T17:34:56.789Z',
    });
  });

  it('carries the time of day into the upper bound, not just the date', () => {
    // The window is a duration from NOW, never "end of the Nth day". A version
    // that truncated to midnight would pass the 7-day case above by accident
    // only if NOW were midnight — which is why NOW is not.
    const { onOrBefore } = expiringWindow(1, NOW);
    expect(onOrBefore).toBe('2026-08-09T17:34:56.789Z');
    expect(onOrBefore.slice(11)).toBe(NOW.slice(11));
  });

  it('crosses a month boundary by real elapsed time', () => {
    expect(expiringWindow(30, NOW).onOrBefore).toBe('2026-09-07T17:34:56.789Z');
  });

  // The two boundary rules are the feature. Assert the SEMANTICS a caller
  // depends on, not just the strings: a row expiring exactly at `now` is
  // already expired and must fall outside; a row expiring exactly at the far
  // edge is "within N days" and must fall inside.
  describe('boundary semantics', () => {
    const { after, onOrBefore } = expiringWindow(7, NOW);
    const inWindow = (expiresAt: string) =>
      Date.parse(expiresAt) > Date.parse(after) && Date.parse(expiresAt) <= Date.parse(onOrBefore);

    it('EXCLUDES a memory expiring exactly at now (already expired)', () => {
      expect(inWindow(NOW)).toBe(false);
    });

    it('INCLUDES a memory expiring one millisecond from now', () => {
      expect(inWindow(new Date(Date.parse(NOW) + 1).toISOString())).toBe(true);
    });

    it('INCLUDES a memory expiring exactly at the far edge — "within 7 days" covers day 7', () => {
      expect(inWindow(onOrBefore)).toBe(true);
    });

    it('EXCLUDES a memory expiring one millisecond past the far edge', () => {
      expect(inWindow(new Date(Date.parse(onOrBefore) + 1).toISOString())).toBe(false);
    });

    it('EXCLUDES a memory that expired in the past', () => {
      expect(inWindow('2026-08-01T00:00:00.000Z')).toBe(false);
    });
  });

  it('accepts both ends of the documented range', () => {
    expect(() => expiringWindow(EXPIRING_WITHIN_DAYS_MIN, NOW)).not.toThrow();
    expect(() => expiringWindow(EXPIRING_WITHIN_DAYS_MAX, NOW)).not.toThrow();
    expect(expiringWindow(EXPIRING_WITHIN_DAYS_MAX, NOW).onOrBefore).toBe('2027-08-08T17:34:56.789Z');
  });

  // Fails LOUD, unlike the telemetry-side `safeValidateScope`. A filter that
  // degrades to a wider window answers a different question than the one asked.
  it.each([
    ['zero — the empty window', 0],
    ['negative', -1],
    ['one past the ceiling', EXPIRING_WITHIN_DAYS_MAX + 1],
    ['fractional', 7.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('throws on %s rather than widening the window', (_label, days) => {
    expect(() => expiringWindow(days, NOW)).toThrow(RangeError);
  });

  it('throws on an unparseable clock rather than emitting an Invalid Date', () => {
    expect(() => expiringWindow(7, 'not-a-timestamp')).toThrow(RangeError);
  });

  /**
   * `@lorekit/schemas` deliberately depends on nothing, so `ListMemoriesQuerySchema`
   * spells the same 1..365 bound as a literal — the arrangement `ttl_days` /
   * `TTL_MIN_DAYS` has always had, and which has no guard. This is that guard:
   * if the two ever disagree, the API would either accept a value the window
   * builder throws on (a 500 where a 400 belongs) or reject one it handles.
   */
  describe('agreement with ListMemoriesQuerySchema', () => {
    const parses = (v: unknown) =>
      ListMemoriesQuerySchema.safeParse({ expiring_within_days: v }).success;

    it('the schema accepts exactly the range the window builder accepts', () => {
      expect(parses(EXPIRING_WITHIN_DAYS_MIN)).toBe(true);
      expect(parses(EXPIRING_WITHIN_DAYS_MAX)).toBe(true);
      expect(parses(EXPIRING_WITHIN_DAYS_MIN - 1)).toBe(false);
      expect(parses(EXPIRING_WITHIN_DAYS_MAX + 1)).toBe(false);
    });

    it('every value the schema admits is one the window builder can build', () => {
      for (const v of [EXPIRING_WITHIN_DAYS_MIN, 7, 30, 90, EXPIRING_WITHIN_DAYS_MAX]) {
        expect(parses(v)).toBe(true);
        expect(() => expiringWindow(v, NOW)).not.toThrow();
      }
    });

    it('coerces the string a query param actually arrives as', () => {
      const parsed = ListMemoriesQuerySchema.parse({ expiring_within_days: '7' });
      expect(parsed.expiring_within_days).toBe(7);
    });

    it('rejects the malformed strings a hand-edited URL produces', () => {
      for (const v of ['7.5', 'abc', '', '0', '366', '-1']) expect(parses(v)).toBe(false);
    });

    it('is absent — not defaulted — when the param is omitted', () => {
      // The handler branches on `!== undefined`, so a default would silently
      // turn every list request into an expiring-soon request.
      expect(ListMemoriesQuerySchema.parse({}).expiring_within_days).toBeUndefined();
    });
  });

  it('normalises a non-UTC clock to UTC on both bounds', () => {
    // The handler passes `new Date().toISOString()`, but the bound must not
    // depend on that: an offset timestamp has to produce the same instant.
    expect(expiringWindow(1, '2026-08-08T19:34:56.789+02:00')).toEqual({
      after: '2026-08-08T17:34:56.789Z',
      onOrBefore: '2026-08-09T17:34:56.789Z',
    });
  });
});
