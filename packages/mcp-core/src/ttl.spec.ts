import { describe, it, expect } from 'vitest';
import {
  parseTtlDays,
  parseTtlMinutes,
  parseTtlSeconds,
  parseTtl,
  TtlError,
  TTL_MIN_DAYS,
  TTL_MAX_DAYS,
  TTL_MIN_MINUTES,
  TTL_MAX_MINUTES,
  TTL_MIN_SECONDS,
  TTL_MAX_SECONDS,
} from './ttl.js';

// ── parseTtlDays ─────────────────────────────────────────────────────────────

describe('parseTtlDays', () => {
  it('returns null when input is undefined', () => {
    expect(parseTtlDays(undefined)).toBeNull();
  });

  it('returns null when input is null', () => {
    expect(parseTtlDays(null)).toBeNull();
  });

  it('returns 1 for the minimum allowed value', () => {
    expect(parseTtlDays(1)).toBe(1);
  });

  it('returns 7 for a typical week TTL', () => {
    expect(parseTtlDays(7)).toBe(7);
  });

  it('returns the maximum allowed value', () => {
    expect(parseTtlDays(TTL_MAX_DAYS)).toBe(TTL_MAX_DAYS);
  });

  it('accepts a numeric string', () => {
    expect(parseTtlDays('5')).toBe(5);
  });

  it('throws TtlError when value is 0', () => {
    expect(() => parseTtlDays(0)).toThrow(TtlError);
    expect(() => parseTtlDays(0)).toThrow(`>= ${TTL_MIN_DAYS}`);
  });

  it('throws TtlError when value is negative', () => {
    expect(() => parseTtlDays(-1)).toThrow(TtlError);
  });

  it('throws TtlError when value exceeds maximum', () => {
    expect(() => parseTtlDays(TTL_MAX_DAYS + 1)).toThrow(TtlError);
    expect(() => parseTtlDays(TTL_MAX_DAYS + 1)).toThrow(`<= ${TTL_MAX_DAYS}`);
  });

  it('throws TtlError when value is a float', () => {
    expect(() => parseTtlDays(3.5)).toThrow(TtlError);
    expect(() => parseTtlDays(3.5)).toThrow('integer');
  });

  it('throws TtlError when value is NaN', () => {
    expect(() => parseTtlDays(NaN)).toThrow(TtlError);
  });

  it('throws TtlError when value is Infinity', () => {
    expect(() => parseTtlDays(Infinity)).toThrow(TtlError);
  });

  it('throws TtlError when value is a non-numeric string', () => {
    expect(() => parseTtlDays('five')).toThrow(TtlError);
  });

  it('does not throw when value is true (coerces to 1, a valid TTL)', () => {
    // Boolean true coerces to 1 via Number(true), which is a valid TTL day.
    expect(parseTtlDays(true)).toBe(1);
  });

  it('throws TtlError when value is an object', () => {
    expect(() => parseTtlDays({})).toThrow(TtlError);
  });
});

// ── parseTtlMinutes ──────────────────────────────────────────────────────────

describe('parseTtlMinutes', () => {
  it('returns null when input is undefined', () => {
    expect(parseTtlMinutes(undefined)).toBeNull();
  });

  it('returns null when input is null', () => {
    expect(parseTtlMinutes(null)).toBeNull();
  });

  it('returns 1 for the minimum allowed value', () => {
    expect(parseTtlMinutes(1)).toBe(1);
  });

  it('returns 60 for a typical one-hour TTL', () => {
    expect(parseTtlMinutes(60)).toBe(60);
  });

  it('returns the maximum allowed value', () => {
    expect(parseTtlMinutes(TTL_MAX_MINUTES)).toBe(TTL_MAX_MINUTES);
  });

  it('accepts a numeric string', () => {
    expect(parseTtlMinutes('30')).toBe(30);
  });

  it('throws TtlError when value is 0', () => {
    expect(() => parseTtlMinutes(0)).toThrow(TtlError);
    expect(() => parseTtlMinutes(0)).toThrow(`>= ${TTL_MIN_MINUTES}`);
  });

  it('throws TtlError when value is negative', () => {
    expect(() => parseTtlMinutes(-1)).toThrow(TtlError);
  });

  it('throws TtlError when value exceeds maximum', () => {
    expect(() => parseTtlMinutes(TTL_MAX_MINUTES + 1)).toThrow(TtlError);
    expect(() => parseTtlMinutes(TTL_MAX_MINUTES + 1)).toThrow(`<= ${TTL_MAX_MINUTES}`);
  });

  it('throws TtlError when value is a float', () => {
    expect(() => parseTtlMinutes(5.5)).toThrow(TtlError);
    expect(() => parseTtlMinutes(5.5)).toThrow('integer');
  });

  it('throws TtlError when value is NaN', () => {
    expect(() => parseTtlMinutes(NaN)).toThrow(TtlError);
  });

  it('throws TtlError when value is Infinity', () => {
    expect(() => parseTtlMinutes(Infinity)).toThrow(TtlError);
  });

  it('throws TtlError when value is a non-numeric string', () => {
    expect(() => parseTtlMinutes('five')).toThrow(TtlError);
  });
});

// ── parseTtlSeconds ──────────────────────────────────────────────────────────

describe('parseTtlSeconds', () => {
  it('returns null when input is undefined', () => {
    expect(parseTtlSeconds(undefined)).toBeNull();
  });

  it('returns null when input is null', () => {
    expect(parseTtlSeconds(null)).toBeNull();
  });

  it('returns 1 for the minimum allowed value', () => {
    expect(parseTtlSeconds(1)).toBe(1);
  });

  it('returns 30 for a typical short TTL', () => {
    expect(parseTtlSeconds(30)).toBe(30);
  });

  it('returns the maximum allowed value', () => {
    expect(parseTtlSeconds(TTL_MAX_SECONDS)).toBe(TTL_MAX_SECONDS);
  });

  it('accepts a numeric string', () => {
    expect(parseTtlSeconds('60')).toBe(60);
  });

  it('throws TtlError when value is 0', () => {
    expect(() => parseTtlSeconds(0)).toThrow(TtlError);
    expect(() => parseTtlSeconds(0)).toThrow(`>= ${TTL_MIN_SECONDS}`);
  });

  it('throws TtlError when value is negative', () => {
    expect(() => parseTtlSeconds(-1)).toThrow(TtlError);
  });

  it('throws TtlError when value exceeds maximum', () => {
    expect(() => parseTtlSeconds(TTL_MAX_SECONDS + 1)).toThrow(TtlError);
    expect(() => parseTtlSeconds(TTL_MAX_SECONDS + 1)).toThrow(`<= ${TTL_MAX_SECONDS}`);
  });

  it('throws TtlError when value is a float', () => {
    expect(() => parseTtlSeconds(1.5)).toThrow(TtlError);
    expect(() => parseTtlSeconds(1.5)).toThrow('integer');
  });

  it('throws TtlError when value is NaN', () => {
    expect(() => parseTtlSeconds(NaN)).toThrow(TtlError);
  });

  it('throws TtlError when value is Infinity', () => {
    expect(() => parseTtlSeconds(Infinity)).toThrow(TtlError);
  });

  it('throws TtlError when value is a non-numeric string', () => {
    expect(() => parseTtlSeconds('five')).toThrow(TtlError);
  });
});

// ── parseTtl (unified resolver) ──────────────────────────────────────────────

describe('parseTtl', () => {
  it('returns null when no unit is supplied', () => {
    expect(parseTtl({})).toBeNull();
  });

  it('converts ttl_days to seconds', () => {
    expect(parseTtl({ ttl_days: 1 })).toBe(86_400);
    expect(parseTtl({ ttl_days: 7 })).toBe(7 * 86_400);
    expect(parseTtl({ ttl_days: 365 })).toBe(365 * 86_400);
  });

  it('converts ttl_minutes to seconds', () => {
    expect(parseTtl({ ttl_minutes: 1 })).toBe(60);
    expect(parseTtl({ ttl_minutes: 60 })).toBe(3_600);
    expect(parseTtl({ ttl_minutes: 90 })).toBe(5_400);
  });

  it('passes ttl_seconds through unchanged', () => {
    expect(parseTtl({ ttl_seconds: 1 })).toBe(1);
    expect(parseTtl({ ttl_seconds: 30 })).toBe(30);
    expect(parseTtl({ ttl_seconds: 3_600 })).toBe(3_600);
  });

  it('throws TtlError when ttl_days and ttl_minutes are both supplied', () => {
    expect(() => parseTtl({ ttl_days: 1, ttl_minutes: 60 })).toThrow(TtlError);
    expect(() => parseTtl({ ttl_days: 1, ttl_minutes: 60 })).toThrow('at most one');
  });

  it('throws TtlError when ttl_days and ttl_seconds are both supplied', () => {
    expect(() => parseTtl({ ttl_days: 1, ttl_seconds: 60 })).toThrow(TtlError);
    expect(() => parseTtl({ ttl_days: 1, ttl_seconds: 60 })).toThrow('at most one');
  });

  it('throws TtlError when ttl_minutes and ttl_seconds are both supplied', () => {
    expect(() => parseTtl({ ttl_minutes: 5, ttl_seconds: 30 })).toThrow(TtlError);
    expect(() => parseTtl({ ttl_minutes: 5, ttl_seconds: 30 })).toThrow('at most one');
  });

  it('throws TtlError when all three units are supplied', () => {
    expect(() => parseTtl({ ttl_days: 1, ttl_minutes: 60, ttl_seconds: 3_600 })).toThrow(TtlError);
  });

  it('propagates validation errors from parseTtlDays', () => {
    expect(() => parseTtl({ ttl_days: 0 })).toThrow(TtlError);
    expect(() => parseTtl({ ttl_days: 366 })).toThrow(TtlError);
  });

  it('propagates validation errors from parseTtlMinutes', () => {
    expect(() => parseTtl({ ttl_minutes: 0 })).toThrow(TtlError);
    expect(() => parseTtl({ ttl_minutes: TTL_MAX_MINUTES + 1 })).toThrow(TtlError);
  });

  it('propagates validation errors from parseTtlSeconds', () => {
    expect(() => parseTtl({ ttl_seconds: 0 })).toThrow(TtlError);
    expect(() => parseTtl({ ttl_seconds: TTL_MAX_SECONDS + 1 })).toThrow(TtlError);
  });

  it('treats null/undefined for unused units as absent', () => {
    expect(parseTtl({ ttl_days: 1, ttl_minutes: null as unknown as undefined })).toBe(86_400);
    expect(parseTtl({ ttl_days: undefined, ttl_minutes: 10 })).toBe(600);
  });
});
