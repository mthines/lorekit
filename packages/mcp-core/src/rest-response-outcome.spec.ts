import { describe, it, expect } from 'vitest';
import { classifyResponseOutcome } from './rest-response-outcome.ts';
import type { RestOutcome } from './rest-response-outcome.ts';

/**
 * Exhaustive over the mapping's decision surface: every status class, both
 * 429 sub-cases, and every shape a missing/malformed body reduces to.
 */

/** The `usage_events.outcome` domain, as the migration/edge writer defines it. */
const OUTCOMES: ReadonlyArray<RestOutcome> = [
  'ok',
  'cap_exceeded',
  'rate_limited',
  'permission_denied',
  'error',
];

describe('classifyResponseOutcome', () => {
  // ── success + redirect classes ────────────────────────────────────────────
  it.each([100, 101, 200, 201, 204, 299, 300, 301, 304, 399])(
    'classifies %i (below 400) as ok',
    (status) => {
      expect(classifyResponseOutcome(status)).toBe('ok');
    },
  );

  // ── permission denied ─────────────────────────────────────────────────────
  it('classifies 403 as permission_denied', () => {
    expect(classifyResponseOutcome(403)).toBe('permission_denied');
  });

  it('classifies 403 as permission_denied regardless of any body code', () => {
    // Only 429 consults the body; 403 must never be diverted by one.
    expect(classifyResponseOutcome(403, 'memory_cap')).toBe('permission_denied');
  });

  // ── the two 429 sub-cases ─────────────────────────────────────────────────
  it('classifies 429 with code=memory_cap as cap_exceeded (the LK001 storage cap)', () => {
    expect(classifyResponseOutcome(429, 'memory_cap')).toBe('cap_exceeded');
  });

  it('classifies 429 with code=rate_limited as rate_limited', () => {
    expect(classifyResponseOutcome(429, 'rate_limited')).toBe('rate_limited');
  });

  it('classifies 429 with an unrelated code as rate_limited', () => {
    expect(classifyResponseOutcome(429, 'something_else')).toBe('rate_limited');
  });

  // ── the malformed / absent body fallback ──────────────────────────────────
  //
  // The router passes `null` when the 429 body is absent, is not JSON, or
  // carries no `code`. All three collapse to the same input here, and all
  // three must yield `rate_limited` — the fallback the original inline
  // `catch` produced.
  it.each([
    ['omitted', undefined],
    ['null (unparseable or bodiless response)', null],
    ['empty string', ''],
  ] as const)('classifies 429 with a %s body code as rate_limited', (_label, code) => {
    expect(classifyResponseOutcome(429, code)).toBe('rate_limited');
  });

  it('does not treat a memory_cap code as a cap on any status other than 429', () => {
    expect(classifyResponseOutcome(400, 'memory_cap')).toBe('error');
    expect(classifyResponseOutcome(500, 'memory_cap')).toBe('error');
    expect(classifyResponseOutcome(200, 'memory_cap')).toBe('ok');
  });

  // ── every other 4xx / 5xx ─────────────────────────────────────────────────
  it.each([400, 401, 404, 405, 409, 410, 418, 422, 428, 430, 499, 500, 502, 503, 504, 599])(
    'classifies %i as error',
    (status) => {
      expect(classifyResponseOutcome(status)).toBe('error');
    },
  );

  // ── totality + anti-vacuity ───────────────────────────────────────────────
  it('returns a member of the outcome domain for every status 100..599', () => {
    const seen = new Set<RestOutcome>();
    for (let status = 100; status <= 599; status++) {
      const outcome = classifyResponseOutcome(status);
      expect(OUTCOMES, `status ${status} produced ${outcome}`).toContain(outcome);
      seen.add(outcome);
    }
    // Without a body code, four of the five buckets are reachable (429 falls
    // to rate_limited). Asserting the exact set stops a degenerate
    // implementation (e.g. always 'error') from satisfying the loop above,
    // and pins that `cap_exceeded` is UNREACHABLE without the body.
    expect([...seen].sort()).toEqual(['error', 'ok', 'permission_denied', 'rate_limited']);
    expect(seen.has('cap_exceeded')).toBe(false);
  });

  it('reaches the remaining two buckets only via the 429 body code', () => {
    expect(classifyResponseOutcome(429, 'memory_cap')).toBe('cap_exceeded');
    expect(classifyResponseOutcome(429)).toBe('rate_limited');
    // And 429 is the ONLY status for which the body code changes the answer.
    const divergent: number[] = [];
    for (let status = 100; status <= 599; status++) {
      if (classifyResponseOutcome(status, 'memory_cap') !== classifyResponseOutcome(status)) {
        divergent.push(status);
      }
    }
    expect(divergent).toEqual([429]);
  });
});
