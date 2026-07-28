import { describe, it, expect } from 'vitest';
import { parseTtlDays, TtlError, TTL_MIN_DAYS, TTL_MAX_DAYS } from './ttl.js';

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
