import { describe, it, expect } from 'vitest';
import { normalizeActions, substringNeedle, dateRangeBounds } from './filters';

const ALLOWED = ['memory.create', 'memory.update', 'api_key.create'] as const;

describe('normalizeActions', () => {
  it('returns [] for undefined input', () => {
    expect(normalizeActions(undefined, ALLOWED)).toEqual([]);
  });

  it('returns [] for empty array input', () => {
    expect(normalizeActions([], ALLOWED)).toEqual([]);
  });

  it('keeps only values present in the allow-set', () => {
    const result = normalizeActions(['memory.create', 'bogus.action', 'api_key.create'], ALLOWED);
    expect(result.sort()).toEqual(['api_key.create', 'memory.create'].sort());
  });

  it('dedupes repeated values', () => {
    const result = normalizeActions(['memory.create', 'memory.create', 'memory.update'], ALLOWED);
    expect(result).toHaveLength(2);
  });

  it('drops values not in the allow-set entirely, returning empty when none match', () => {
    expect(normalizeActions(['nope', 'still-nope'], ALLOWED)).toEqual([]);
  });
});

describe('substringNeedle', () => {
  it('returns null for undefined', () => {
    expect(substringNeedle(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(substringNeedle('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(substringNeedle('   ')).toBeNull();
    expect(substringNeedle('\t\n')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(substringNeedle('  hello  ')).toBe('hello');
  });

  it('preserves unicode content untouched (besides trim/escaping)', () => {
    expect(substringNeedle('  ünïcödé 🎉 tëst  ')).toBe('ünïcödé 🎉 tëst');
  });

  it('escapes LIKE wildcard metacharacters % and _', () => {
    expect(substringNeedle('100%_done')).toBe('100\\%\\_done');
  });

  it('escapes commas and parentheses (PostgREST-reserved)', () => {
    expect(substringNeedle('a,b(c)d')).toBe('a\\,b\\(c\\)d');
  });

  it('escapes a literal backslash before other escapes compound', () => {
    expect(substringNeedle('a\\b')).toBe('a\\\\b');
  });

  it('passes plain alphanumeric text through unchanged', () => {
    expect(substringNeedle('lorekit-io')).toBe('lorekit-io');
  });
});

describe('dateRangeBounds', () => {
  it('returns {} for null/undefined range', () => {
    expect(dateRangeBounds(null)).toEqual({});
    expect(dateRangeBounds(undefined)).toEqual({});
  });

  it('returns {} when neither from nor to is set', () => {
    expect(dateRangeBounds({})).toEqual({});
  });

  it('applies only gte when from is set alone', () => {
    expect(dateRangeBounds({ from: '2026-07-01' })).toEqual({ gte: '2026-07-01' });
  });

  it('applies only lt when to is set alone (date-only, half-open next-day)', () => {
    expect(dateRangeBounds({ to: '2026-07-01' })).toEqual({ lt: '2026-07-02T00:00:00.000Z' });
  });

  it('applies both bounds when from and to are both date-only', () => {
    expect(dateRangeBounds({ from: '2026-07-01', to: '2026-07-05' })).toEqual({
      gte: '2026-07-01',
      lt: '2026-07-06T00:00:00.000Z',
    });
  });

  it('uses a full ISO timestamp `to` as-is (no next-day bump)', () => {
    expect(dateRangeBounds({ to: '2026-07-01T15:30:00.000Z' })).toEqual({
      lt: '2026-07-01T15:30:00.000Z',
    });
  });

  it('uses a full ISO timestamp `from` as-is', () => {
    expect(dateRangeBounds({ from: '2026-07-01T15:30:00.000Z' })).toEqual({
      gte: '2026-07-01T15:30:00.000Z',
    });
  });

  it('handles a from/to spanning a UTC month boundary correctly', () => {
    expect(dateRangeBounds({ from: '2026-07-30', to: '2026-07-31' })).toEqual({
      gte: '2026-07-30',
      lt: '2026-08-01T00:00:00.000Z',
    });
  });
});
