import { describe, it, expect } from 'vitest';
import { formatPostDate, readingLabel } from './format';

describe('formatPostDate', () => {
  it('formats an ISO date as a long US date in UTC', () => {
    expect(formatPostDate('2026-08-01')).toBe('August 1, 2026');
    expect(formatPostDate('2026-12-25')).toBe('December 25, 2026');
  });

  it('parses in UTC so the day never shifts by timezone', () => {
    // Midnight UTC must stay on the 1st regardless of the runner's local zone.
    expect(formatPostDate('2026-08-01T00:00:00Z')).toBe('August 1, 2026');
  });

  it('returns the raw input for an unparseable date instead of throwing', () => {
    expect(formatPostDate('not-a-date')).toBe('not-a-date');
    expect(formatPostDate('')).toBe('');
  });
});

describe('readingLabel', () => {
  it('renders a minutes label', () => {
    expect(readingLabel(8)).toBe('8 min read');
    expect(readingLabel(1)).toBe('1 min read');
  });

  it('rounds and floors to at least one minute', () => {
    expect(readingLabel(7.4)).toBe('7 min read');
    expect(readingLabel(0)).toBe('1 min read');
    expect(readingLabel(Number.NaN)).toBe('1 min read');
  });
});
