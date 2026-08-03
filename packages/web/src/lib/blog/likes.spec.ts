import { describe, it, expect } from 'vitest';
import {
  MAX_SESSION_LIKES,
  sessionLikesKey,
  clampSessionLikes,
  parseSessionLikes,
  remainingSessionLikes,
  isSessionMaxed,
  warmthRatio,
  clampLikeDelta,
  formatLikeCount,
} from './likes';

describe('sessionLikesKey', () => {
  it('namespaces the key by slug', () => {
    expect(sessionLikesKey('hello-world')).toBe('lorekit:blog-likes:hello-world');
  });
});

describe('clampSessionLikes', () => {
  it('passes through values in range', () => {
    expect(clampSessionLikes(0)).toBe(0);
    expect(clampSessionLikes(42)).toBe(42);
    expect(clampSessionLikes(MAX_SESSION_LIKES)).toBe(MAX_SESSION_LIKES);
  });

  it('floors below 0 and caps above MAX', () => {
    expect(clampSessionLikes(-3)).toBe(0);
    expect(clampSessionLikes(1000)).toBe(MAX_SESSION_LIKES);
  });

  it('truncates fractions and treats non-finite input as 0 (fail-safe)', () => {
    expect(clampSessionLikes(7.9)).toBe(7);
    expect(clampSessionLikes(Number.NaN)).toBe(0);
    expect(clampSessionLikes(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('parseSessionLikes', () => {
  it('reads a stored numeric string', () => {
    expect(parseSessionLikes('12')).toBe(12);
  });

  it('fails safe to 0 for null, undefined, or garbage', () => {
    expect(parseSessionLikes(null)).toBe(0);
    expect(parseSessionLikes(undefined)).toBe(0);
    expect(parseSessionLikes('not-a-number')).toBe(0);
  });

  it('clamps an out-of-range stored value', () => {
    expect(parseSessionLikes('999')).toBe(MAX_SESSION_LIKES);
    expect(parseSessionLikes('-5')).toBe(0);
  });
});

describe('remainingSessionLikes / isSessionMaxed', () => {
  it('reports the remaining allowance', () => {
    expect(remainingSessionLikes(0)).toBe(MAX_SESSION_LIKES);
    expect(remainingSessionLikes(90)).toBe(10);
  });

  it('treats the cap (and beyond) as maxed', () => {
    expect(isSessionMaxed(99)).toBe(false);
    expect(isSessionMaxed(100)).toBe(true);
    expect(isSessionMaxed(150)).toBe(true);
  });
});

describe('warmthRatio', () => {
  it('scales 0..1 across the cap', () => {
    expect(warmthRatio(0)).toBe(0);
    expect(warmthRatio(50)).toBe(0.5);
    expect(warmthRatio(100)).toBe(1);
  });

  it('never exceeds 1', () => {
    expect(warmthRatio(500)).toBe(1);
  });
});

describe('clampLikeDelta', () => {
  it('keeps a single valid increment', () => {
    expect(clampLikeDelta(1)).toBe(1);
    expect(clampLikeDelta(7)).toBe(7);
  });

  it('floors a 0/negative delta to 1 (never a decrement)', () => {
    expect(clampLikeDelta(0)).toBe(1);
    expect(clampLikeDelta(-4)).toBe(1);
    expect(clampLikeDelta(Number.NaN)).toBe(1);
  });

  it('caps an over-large delta at MAX', () => {
    expect(clampLikeDelta(9999)).toBe(MAX_SESSION_LIKES);
  });
});

describe('formatLikeCount', () => {
  it('renders small counts plainly', () => {
    expect(formatLikeCount(0)).toBe('0');
    expect(formatLikeCount(7)).toBe('7');
    expect(formatLikeCount(999)).toBe('999');
  });

  it('uses compact notation for large counts', () => {
    expect(formatLikeCount(1234)).toBe('1.2K');
    expect(formatLikeCount(12000)).toBe('12K');
  });

  it('reads negative or non-finite input as 0', () => {
    expect(formatLikeCount(-5)).toBe('0');
    expect(formatLikeCount(Number.NaN)).toBe('0');
  });
});
