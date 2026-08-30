import { describe, it, expect } from 'vitest';
import {
  UNBOUNDED_STATS_RANGE,
  effectiveStatsRange,
  statsWindow,
} from './explorer-stats';
import { rangeCaption, resolveRange, type TimeRange } from '@/lib/time-range';

const NOW = '2026-08-08T17:34:56.789Z';

describe('effectiveStatsRange', () => {
  it('passes a bounded range through untouched', () => {
    const preset: TimeRange = { preset: '7d' };
    expect(effectiveStatsRange(preset, NOW)).toBe(preset);

    const absolute: TimeRange = { from: '2026-07-01', to: '2026-07-03' };
    expect(effectiveStatsRange(absolute, NOW)).toBe(absolute);
  });

  it('substitutes a bounded range for BOTH spellings of unbounded', () => {
    // "All time" is a legitimate selection for a list and not for a chart:
    // /activity would return every bucket the account ever produced.
    expect(effectiveStatsRange(null, NOW)).toEqual(UNBOUNDED_STATS_RANGE);
    expect(effectiveStatsRange({ preset: 'all' }, NOW)).toEqual(UNBOUNDED_STATS_RANGE);
  });

  it('substitutes for a MALFORMED range too, since that also resolves unbounded', () => {
    // A hand-edited link must chart something, not query all of history.
    expect(effectiveStatsRange({ from: 'nope', to: 'also-nope' }, NOW)).toEqual(
      UNBOUNDED_STATS_RANGE,
    );
  });

  /**
   * The honesty property, and the reason this substitutes the RANGE rather than
   * just capping the query window: the cards caption whatever range they are
   * given, so a capped fetch under an "all time" caption would print a 90-day
   * number and call it the account's history.
   */
  it('makes the caption describe the period actually charted', () => {
    const shown = effectiveStatsRange(null, NOW);
    expect(rangeCaption(shown, NOW)).toBe('the last 90 days');
    expect(rangeCaption(shown, NOW)).not.toBe('all time');
  });
});

describe('statsWindow', () => {
  it('queries exactly the selected window for a bounded range', () => {
    const window = resolveRange({ from: '2026-07-01', to: '2026-07-03' }, NOW);
    expect(statsWindow({ from: '2026-07-01', to: '2026-07-03' }, NOW)).toEqual({
      since: window?.from,
      until: window?.to,
    });
  });

  it('bounds an unbounded selection to the substituted range', () => {
    const { since, until } = statsWindow(null, NOW);
    const spanDays = (Date.parse(until) - Date.parse(since)) / 86_400_000;
    expect(spanDays).toBe(90);
    expect(until).toBe(NOW);
  });

  it('agrees with what effectiveStatsRange resolves to', () => {
    // The two must not drift: the grid, the anchor and the captions come from
    // the effective range while the fetch comes from here, and a mismatch would
    // chart one period under another's label.
    for (const range of [
      null,
      { preset: 'all' } as const,
      { preset: '24h' } as const,
      { from: '2026-07-01', to: '2026-07-03' },
    ]) {
      const shown = effectiveStatsRange(range as TimeRange, NOW);
      expect(statsWindow(range as TimeRange, NOW)).toEqual({
        since: resolveRange(shown, NOW)?.from,
        until: resolveRange(shown, NOW)?.to,
      });
    }
  });

  it('never returns an inverted window', () => {
    for (const range of [null, { preset: '24h' } as const, { from: 'x', to: 'y' }]) {
      const { since, until } = statsWindow(range as TimeRange, NOW);
      expect(Date.parse(until)).toBeGreaterThanOrEqual(Date.parse(since));
    }
  });
});
