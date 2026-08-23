import { describe, it, expect } from 'vitest';

import { attributeIoTime, mergeBusyMs } from './io-ledger.js';

describe('mergeBusyMs — overlaps count once', () => {
  it('is zero for no intervals', () => {
    expect(mergeBusyMs([])).toBe(0);
  });

  it('returns the length of a single interval', () => {
    expect(mergeBusyMs([{ startMs: 100, endMs: 140 }])).toBe(40);
  });

  it('sums disjoint intervals', () => {
    expect(mergeBusyMs([
      { startMs: 0, endMs: 10 },
      { startMs: 50, endMs: 65 },
    ])).toBe(25);
  });

  it('counts two fully concurrent calls ONCE (the Promise.all case)', () => {
    // Both queries ran for the same 40 ms window. Summing would claim 80 ms of
    // I/O in a request that waited 40 — the bug this module exists to prevent.
    expect(mergeBusyMs([
      { startMs: 100, endMs: 140 },
      { startMs: 100, endMs: 140 },
    ])).toBe(40);
  });

  it('merges partial overlaps into their union', () => {
    expect(mergeBusyMs([
      { startMs: 0, endMs: 30 },
      { startMs: 20, endMs: 50 },
    ])).toBe(50);
  });

  it('absorbs an interval fully contained in another', () => {
    expect(mergeBusyMs([
      { startMs: 0, endMs: 100 },
      { startMs: 30, endMs: 40 },
    ])).toBe(100);
  });

  it('is independent of input order', () => {
    const shuffled = [
      { startMs: 20, endMs: 50 },
      { startMs: 90, endMs: 95 },
      { startMs: 0, endMs: 30 },
    ];
    expect(mergeBusyMs(shuffled)).toBe(55);
    expect(mergeBusyMs([...shuffled].reverse())).toBe(55);
  });

  it('treats touching intervals as one continuous run', () => {
    expect(mergeBusyMs([
      { startMs: 0, endMs: 10 },
      { startMs: 10, endMs: 20 },
    ])).toBe(20);
  });

  it('chains a stretch across three staggered calls', () => {
    expect(mergeBusyMs([
      { startMs: 0, endMs: 10 },
      { startMs: 5, endMs: 20 },
      { startMs: 18, endMs: 25 },
    ])).toBe(25);
  });

  it('banks a completed run before opening the next one', () => {
    // Regression guard: an implementation that only ever stretched `runEnd`
    // would report 100 here instead of 20 + 20.
    expect(mergeBusyMs([
      { startMs: 0, endMs: 20 },
      { startMs: 80, endMs: 100 },
    ])).toBe(40);
  });

  it('collapses a backwards interval instead of extending the union leftwards', () => {
    expect(mergeBusyMs([{ startMs: 100, endMs: 90 }])).toBe(0);
    expect(mergeBusyMs([
      { startMs: 0, endMs: 10 },
      { startMs: 100, endMs: 90 },
    ])).toBe(10);
  });

  it('drops non-finite bounds rather than returning NaN', () => {
    expect(mergeBusyMs([
      { startMs: 0, endMs: 10 },
      { startMs: Number.NaN, endMs: 50 },
      { startMs: 60, endMs: Number.POSITIVE_INFINITY },
    ])).toBe(10);
  });
});

describe('attributeIoTime — the self/wait split', () => {
  it('attributes everything not covered by a call to self time', () => {
    expect(attributeIoTime(100, [{ startMs: 10, endMs: 40 }])).toEqual({
      waitMs: 30,
      selfMs: 70,
      calls: 1,
    });
  });

  it('reports the whole request as self time when nothing was called', () => {
    expect(attributeIoTime(12, [])).toEqual({ waitMs: 0, selfMs: 12, calls: 0 });
  });

  it('counts calls without merging them, so concurrency stays visible', () => {
    // Two concurrent 40 ms queries: 40 ms waited, but 2 calls made. The count
    // is what tells an N+1 apart from one slow query.
    const attribution = attributeIoTime(50, [
      { startMs: 0, endMs: 40 },
      { startMs: 0, endMs: 40 },
    ]);
    expect(attribution.waitMs).toBe(40);
    expect(attribution.calls).toBe(2);
    expect(attribution.selfMs).toBe(10);
  });

  it('clamps self time at zero when wait exceeds the measured total', () => {
    // Tick-level noise: a child span ended after the parent read its own clock.
    expect(attributeIoTime(30, [{ startMs: 0, endMs: 32 }]).selfMs).toBe(0);
  });

  it('clamps a negative or non-finite total instead of propagating it', () => {
    expect(attributeIoTime(-5, []).selfMs).toBe(0);
    expect(attributeIoTime(Number.NaN, []).selfMs).toBe(0);
  });

  it('does not count an unusable interval as a call', () => {
    expect(attributeIoTime(10, [{ startMs: Number.NaN, endMs: 5 }]).calls).toBe(0);
  });
});
