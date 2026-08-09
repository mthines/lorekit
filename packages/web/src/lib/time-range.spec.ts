import { describe, it, expect } from 'vitest';
import {
  resolveRange,
  bucketPlanFor,
  bucketPlanForRange,
  rangeForBucket,
  rangeLabel,
  toDayRange,
  isPresetRange,
  isDayString,
  HOUR_LADDER_MAX_MS,
  HOUR_MS,
  DAY_MS,
  RANGE_PRESETS,
  type AbsoluteRange,
  type TimeRange,
} from './time-range';

/**
 * A frozen clock, deliberately mid-hour and mid-day: a resolver that silently
 * truncated to a bucket boundary would pass every assertion below if this were
 * midnight, and fail loudly as it should now.
 */
const NOW = '2026-08-08T17:34:56.789Z';

/**
 * Narrow a resolved window, failing the test with a useful message instead of
 * a `!` assertion — a null here means the resolver returned unbounded, which is
 * a different bug from the span being wrong, and should say so.
 */
function requireWindow(window: AbsoluteRange | null): AbsoluteRange {
  if (window === null) throw new Error('expected a resolved window, got null (unbounded)');
  return window;
}

/** Milliseconds a resolved window spans. */
function spanOf(window: AbsoluteRange | null): number {
  const w = requireWindow(window);
  return Date.parse(w.to) - Date.parse(w.from);
}

describe('resolveRange — presets', () => {
  it('resolves a preset to [now − span, now) from the injected clock', () => {
    expect(resolveRange({ preset: '24h' }, NOW)).toEqual({
      from: '2026-08-07T17:34:56.789Z',
      to: NOW,
    });
    expect(resolveRange({ preset: '7d' }, NOW)).toEqual({
      from: '2026-08-01T17:34:56.789Z',
      to: NOW,
    });
    expect(resolveRange({ preset: '90d' }, NOW)?.from).toBe('2026-05-10T17:34:56.789Z');
  });

  it('keeps the preset relative — the same value resolves differently as time passes', () => {
    // This is the whole reason presets stay in the URL as presets. If they were
    // frozen to instants at click time, a shared "last 24 hours" link would show
    // a fixed historical day forever.
    const later = '2026-08-09T17:34:56.789Z';
    const a = resolveRange({ preset: '24h' }, NOW);
    const b = resolveRange({ preset: '24h' }, later);
    expect(a).not.toEqual(b);
    expect(b?.to).toBe(later);
  });

  it('treats "all" as genuinely unbounded, not a very large window', () => {
    expect(resolveRange({ preset: 'all' }, NOW)).toBeNull();
    expect(resolveRange(null, NOW)).toBeNull();
  });

  it('every declared preset resolves without throwing', () => {
    for (const preset of RANGE_PRESETS) {
      expect(() => resolveRange({ preset }, NOW)).not.toThrow();
    }
  });
});

describe('resolveRange — absolute windows', () => {
  it('passes ISO instants through as a half-open window', () => {
    const range = { from: '2026-08-08T09:00:00.000Z', to: '2026-08-08T11:00:00.000Z' };
    expect(resolveRange(range, NOW)).toEqual(range);
  });

  it('does NOT move with the clock', () => {
    const range = { from: '2026-08-08T09:00:00.000Z', to: '2026-08-08T11:00:00.000Z' };
    expect(resolveRange(range, '2027-01-01T00:00:00.000Z')).toEqual(range);
  });

  it('normalises an offset timestamp to UTC', () => {
    expect(resolveRange({ from: '2026-08-08T11:00:00+02:00', to: '2026-08-08T13:00:00+02:00' }, NOW)).toEqual({
      from: '2026-08-08T09:00:00.000Z',
      to: '2026-08-08T11:00:00.000Z',
    });
  });
});

/**
 * `?range=` has always been a `{from,to}` pair of UTC day strings, it is a
 * DOCUMENTED public contract (`docs/deep-links.mdx`), and the CLI's `lorekit
 * link` emits it. Links already exist in PRs and Slack messages; they have to
 * keep resolving to the same window they always did.
 */
describe('resolveRange — legacy YYYY-MM-DD back-compat', () => {
  it('expands a bare day pair to whole UTC days with an INCLUSIVE end day', () => {
    // Three days, not two: the `to` day is included, so its exclusive bound is
    // the start of the 4th. This is the exact rule dateRangeBounds already used.
    expect(resolveRange({ from: '2026-07-01', to: '2026-07-03' }, NOW)).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-04T00:00:00.000Z',
    });
  });

  it('resolves a single-day selection to exactly that 24h window', () => {
    // The heatmap's day click produces from === to; it must not collapse to an
    // empty window.
    const window = resolveRange({ from: '2026-07-01', to: '2026-07-01' }, NOW);
    expect(window).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
    });
    expect(spanOf(window)).toBe(DAY_MS);
  });

  it('handles a mixed pair — a day lower bound with an instant upper bound', () => {
    expect(resolveRange({ from: '2026-07-01', to: '2026-07-01T06:00:00.000Z' }, NOW)).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-01T06:00:00.000Z',
    });
  });

  it('an ISO upper bound is exclusive verbatim — it is NOT rounded up a day', () => {
    // The discriminating case for applying the day rule to an instant: doing so
    // would silently widen every hour drill-down by 24 hours.
    const window = resolveRange({ from: '2026-07-01T05:00:00.000Z', to: '2026-07-01T06:00:00.000Z' }, NOW);
    expect(spanOf(window)).toBe(HOUR_MS);
  });
});

describe('resolveRange — malformed input fails OPEN', () => {
  it.each([
    ['an unparseable lower bound', { from: 'yesterday', to: '2026-07-03' }],
    ['an unparseable upper bound', { from: '2026-07-01', to: 'tomorrow' }],
    ['a backwards window', { from: '2026-07-03T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }],
    ['an empty window', { from: '2026-07-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }],
  ])('returns null (unbounded) for %s', (_label, range) => {
    // Unbounded is the visible failure — the reader sees everything and can tell
    // something is off. A silently narrowed window looks like a real answer.
    expect(resolveRange(range as TimeRange, NOW)).toBeNull();
  });

  it('returns null for an unparseable clock rather than an Invalid Date window', () => {
    expect(resolveRange({ preset: '24h' }, 'not-a-clock')).toBeNull();
  });
});

describe('bucketPlanFor — the range→bucket ladder', () => {
  const windowOf = (spanMs: number) => ({
    from: new Date(Date.parse(NOW) - spanMs).toISOString(),
    to: NOW,
  });

  it('charts short windows in HOURS', () => {
    expect(bucketPlanFor(windowOf(HOUR_MS)).unit).toBe('hour');
    expect(bucketPlanFor(windowOf(24 * HOUR_MS))).toEqual({ unit: 'hour', count: 24 });
  });

  it('charts long windows in DAYS', () => {
    expect(bucketPlanFor(windowOf(7 * DAY_MS))).toEqual({ unit: 'day', count: 7 });
    expect(bucketPlanFor(windowOf(90 * DAY_MS))).toEqual({ unit: 'day', count: 90 });
  });

  it('switches at exactly 48h, inclusive', () => {
    // The documented threshold, asserted at the boundary and one millisecond
    // either side — the only place an off-by-one can hide.
    expect(bucketPlanFor(windowOf(HOUR_LADDER_MAX_MS)).unit).toBe('hour');
    expect(bucketPlanFor(windowOf(HOUR_LADDER_MAX_MS + 1)).unit).toBe('day');
    expect(bucketPlanFor(windowOf(HOUR_LADDER_MAX_MS - 1)).unit).toBe('hour');
  });

  it('rounds a partial trailing bucket UP so it is still charted', () => {
    expect(bucketPlanFor(windowOf(90 * 60_000))).toEqual({ unit: 'hour', count: 2 });
  });

  it('never returns a zero-bucket plan for a sub-bucket window', () => {
    expect(bucketPlanFor(windowOf(1)).count).toBe(1);
  });

  it('agrees with the preset windows the Overview charts', () => {
    // The ladder must reproduce the grid the cards used before this model
    // existed (24h → 24 hourly, 7d → 7 daily, 30d → 30 daily), or the Overview
    // silently re-buckets on the day this lands.
    expect(bucketPlanForRange({ preset: '24h' }, NOW)).toEqual({ unit: 'hour', count: 24 });
    expect(bucketPlanForRange({ preset: '7d' }, NOW)).toEqual({ unit: 'day', count: 7 });
    expect(bucketPlanForRange({ preset: '30d' }, NOW)).toEqual({ unit: 'day', count: 30 });
    expect(bucketPlanForRange({ preset: '90d' }, NOW)).toEqual({ unit: 'day', count: 90 });
  });

  it('has NO grid for an unbounded range, and says so instead of inventing one', () => {
    expect(bucketPlanForRange({ preset: 'all' }, NOW)).toBeNull();
    expect(bucketPlanForRange(null, NOW)).toBeNull();
  });
});

describe('rangeForBucket — the drill-down builder', () => {
  it('turns an hour bucket into exactly that hour', () => {
    expect(rangeForBucket('2026-08-08T14:00:00.000Z', 'hour')).toEqual({
      from: '2026-08-08T14:00:00.000Z',
      to: '2026-08-08T15:00:00.000Z',
    });
  });

  it('turns a day bucket into exactly that day', () => {
    expect(rangeForBucket('2026-08-08T00:00:00.000Z', 'day')).toEqual({
      from: '2026-08-08T00:00:00.000Z',
      to: '2026-08-09T00:00:00.000Z',
    });
  });

  it('crosses a day boundary from the last hour of a day', () => {
    expect(rangeForBucket('2026-08-08T23:00:00.000Z', 'hour').to).toBe('2026-08-09T00:00:00.000Z');
  });

  it('crosses a month boundary from the last day of a month', () => {
    expect(rangeForBucket('2026-08-31T00:00:00.000Z', 'day').to).toBe('2026-09-01T00:00:00.000Z');
  });

  it('does NOT re-truncate an unaligned bucket start', () => {
    // The server already anchors buckets with date_trunc, so re-truncating here
    // would be a no-op today — and a wrong answer the first time a caller passes
    // something unaligned. Adding one unit is the whole contract.
    expect(rangeForBucket('2026-08-08T14:37:00.000Z', 'hour')).toEqual({
      from: '2026-08-08T14:37:00.000Z',
      to: '2026-08-08T15:37:00.000Z',
    });
  });

  it('throws on an unparseable bucket start rather than emitting Invalid Date', () => {
    expect(() => rangeForBucket('nope', 'hour')).toThrow(RangeError);
  });

  /**
   * The round trip that makes drill-down coherent: the window a click produces
   * must be one the model reads back at the granularity that was clicked.
   */
  it('round-trips: a drilled hour resolves back to a 1-bucket hourly plan', () => {
    const drilled = rangeForBucket('2026-08-08T14:00:00.000Z', 'hour');
    expect(resolveRange(drilled, NOW)).toEqual(drilled);
    expect(bucketPlanFor(drilled)).toEqual({ unit: 'hour', count: 1 });
  });

  it('round-trips: a drilled day resolves back to a 1-bucket hourly plan', () => {
    // A 24h window is at the hour end of the ladder, so drilling into a DAY
    // hands the reader 24 hourly bars to drill again — the second step of the
    // drill-down, and the reason the ladder is inclusive at 48h.
    const drilled = rangeForBucket('2026-08-08T00:00:00.000Z', 'day');
    expect(bucketPlanFor(drilled)).toEqual({ unit: 'hour', count: 24 });
  });
});

describe('toDayRange', () => {
  it('reports the day of the last instant INSIDE the window, not the exclusive bound', () => {
    // A single day must light exactly one heatmap cell. Using the exclusive
    // bound's day would light two.
    expect(toDayRange({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' })).toEqual({
      from: '2026-07-01',
      to: '2026-07-01',
    });
  });

  it('spans the whole selection for a multi-day window', () => {
    expect(toDayRange({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-04T00:00:00.000Z' })).toEqual({
      from: '2026-07-01',
      to: '2026-07-03',
    });
  });

  it('collapses a sub-day window onto its single day', () => {
    expect(toDayRange(rangeForBucket('2026-08-08T14:00:00.000Z', 'hour'))).toEqual({
      from: '2026-08-08',
      to: '2026-08-08',
    });
  });

  it('round-trips a legacy day pair back to itself', () => {
    // The property that makes it safe to resolve first and render second: a
    // day-string selection must survive the trip through instants unchanged.
    const legacy = { from: '2026-07-01', to: '2026-07-03' };
    expect(toDayRange(requireWindow(resolveRange(legacy, NOW)))).toEqual(legacy);
  });
});

describe('type guards', () => {
  it('isPresetRange distinguishes the two arms', () => {
    expect(isPresetRange({ preset: '7d' })).toBe(true);
    expect(isPresetRange({ from: '2026-07-01', to: '2026-07-02' })).toBe(false);
    expect(isPresetRange(null)).toBe(false);
  });

  it('isDayString accepts only a bare UTC day', () => {
    expect(isDayString('2026-07-01')).toBe(true);
    expect(isDayString('2026-07-01T00:00:00.000Z')).toBe(false);
    expect(isDayString('2026-7-1')).toBe(false);
    expect(isDayString('')).toBe(false);
  });
});

describe('rangeLabel', () => {
  it('names the presets', () => {
    expect(rangeLabel({ preset: '24h' }, NOW)).toBe('Last 24 hours');
    expect(rangeLabel({ preset: '90d' }, NOW)).toBe('Last 90 days');
  });

  // The Overview's card captions are `in the ${rangeLabel(...).toLowerCase()}`,
  // where they used to be `in the last ${RANGE_NOUN[range]}`. That refactor is
  // only safe while the two produce the SAME sentence — the committed visual
  // baselines pin those captions pixel for pixel, and an interaction test reads
  // "in the last 30 days" literally. Pin the phrasing here so a future reword of
  // rangeLabel fails a fast unit test instead of a slow browser snapshot.
  it('lowercases into the exact caption phrasing the stat cards had before', () => {
    const caption = (preset: '24h' | '7d' | '30d') =>
      `in the ${rangeLabel({ preset }, NOW).toLowerCase()}`;
    expect(caption('24h')).toBe('in the last 24 hours');
    expect(caption('7d')).toBe('in the last 7 days');
    expect(caption('30d')).toBe('in the last 30 days');
  });

  it('calls both spellings of unbounded "All time"', () => {
    expect(rangeLabel(null, NOW)).toBe('All time');
    expect(rangeLabel({ preset: 'all' }, NOW)).toBe('All time');
  });

  it('renders the last instant INSIDE the window, not the exclusive bound', () => {
    // A single day must read as that day, never as a span ending on the
    // following midnight — the classic off-by-one in a half-open window's label.
    expect(rangeLabel({ from: '2026-07-01', to: '2026-07-01' }, NOW)).toBe('Jul 1');
  });

  it('renders a multi-day window as its inclusive end date', () => {
    expect(rangeLabel({ from: '2026-07-01', to: '2026-07-03' }, NOW)).toBe('Jul 1 – Jul 3');
  });

  it('falls back to All time for a malformed window', () => {
    expect(rangeLabel({ from: 'nope', to: 'also-nope' }, NOW)).toBe('All time');
  });
});
