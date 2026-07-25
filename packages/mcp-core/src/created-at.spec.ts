import { describe, it, expect } from 'vitest';
import { parseCreatedAt, CreatedAtError, CLOCK_SKEW_MS } from './created-at.js';

// A fixed reference "now" so future-date assertions are deterministic.
const NOW = new Date('2026-07-25T12:00:00.000Z');

describe('parseCreatedAt', () => {
  it('returns null when no value is supplied (undefined)', () => {
    expect(parseCreatedAt(undefined, NOW)).toBeNull();
  });

  it('returns null when the value is null', () => {
    expect(parseCreatedAt(null, NOW)).toBeNull();
  });

  it('normalises a valid past ISO timestamp to canonical ISO form', () => {
    expect(parseCreatedAt('2021-03-04T05:06:07.000Z', NOW)).toBe('2021-03-04T05:06:07.000Z');
  });

  it('normalises a date-only string to an ISO date-time', () => {
    expect(parseCreatedAt('2020-01-01', NOW)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseCreatedAt('  2020-01-01T00:00:00Z  ', NOW)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('accepts a timestamp within the clock-skew tolerance of now', () => {
    const nearFuture = new Date(NOW.getTime() + CLOCK_SKEW_MS - 1_000).toISOString();
    expect(parseCreatedAt(nearFuture, NOW)).toBe(nearFuture);
  });

  it('throws CreatedAtError for a future timestamp beyond the skew tolerance', () => {
    const future = new Date(NOW.getTime() + CLOCK_SKEW_MS + 60_000).toISOString();
    expect(() => parseCreatedAt(future, NOW)).toThrow(CreatedAtError);
    expect(() => parseCreatedAt(future, NOW)).toThrow(/future/);
  });

  it('throws CreatedAtError for an unparseable string', () => {
    expect(() => parseCreatedAt('not-a-date', NOW)).toThrow(CreatedAtError);
    expect(() => parseCreatedAt('not-a-date', NOW)).toThrow(/valid date-time/);
  });

  it('throws CreatedAtError for an empty string', () => {
    expect(() => parseCreatedAt('', NOW)).toThrow(CreatedAtError);
  });

  it('throws CreatedAtError for a whitespace-only string', () => {
    expect(() => parseCreatedAt('   ', NOW)).toThrow(CreatedAtError);
  });

  it('throws CreatedAtError for a non-string, non-null value (number)', () => {
    expect(() => parseCreatedAt(1_700_000_000_000, NOW)).toThrow(CreatedAtError);
  });

  it('defaults now to the current time when not provided', () => {
    // A clearly-past date must pass against the real clock.
    expect(parseCreatedAt('2000-01-01T00:00:00Z')).toBe('2000-01-01T00:00:00.000Z');
  });
});
