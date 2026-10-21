import { describe, expect, it } from 'vitest';
import type { ActivityBucket, ReadActivityBucket } from '@lorekit/schemas/memory';
import {
  ROW_CAP,
  bucketStarts,
  chosenShare,
  isAtRowCap,
  loopStages,
  periodChange,
  pulseBuckets,
  pulseTotals,
  rawTotals,
} from './insights-loop';

const write = (bucket: string, count: number, scope = 'global'): ActivityBucket => ({ bucket, scope, count });
const read = (bucket: string, count: number, read_kind?: 'targeted' | 'bulk', scope: string | null = 'global'): ReadActivityBucket => ({
  bucket,
  scope,
  count,
  ...(read_kind ? { read_kind } : {}),
});

describe('isAtRowCap', () => {
  it('flags a response at or above the PostgREST row cap', () => {
    expect(isAtRowCap(ROW_CAP - 1)).toBe(false);
    expect(isAtRowCap(ROW_CAP)).toBe(true);
    expect(isAtRowCap(ROW_CAP + 5)).toBe(true);
  });
});

describe('bucketStarts', () => {
  it('covers every UTC day bucket the window touches, including a partial first day', () => {
    expect(bucketStarts({ from: '2026-06-12T14:00:00.000Z', to: '2026-06-15T12:00:00.000Z' }, 'day')).toEqual([
      '2026-06-12T00:00:00.000Z',
      '2026-06-13T00:00:00.000Z',
      '2026-06-14T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    ]);
  });

  it('steps by the hour for hourly buckets', () => {
    expect(bucketStarts({ from: '2026-06-15T09:30:00.000Z', to: '2026-06-15T12:00:00.000Z' }, 'hour')).toEqual([
      '2026-06-15T09:00:00.000Z',
      '2026-06-15T10:00:00.000Z',
      '2026-06-15T11:00:00.000Z',
    ]);
  });

  it('returns nothing for an inverted or unparseable window', () => {
    expect(bucketStarts({ from: '2026-06-15T12:00:00.000Z', to: '2026-06-15T09:00:00.000Z' }, 'hour')).toEqual([]);
    expect(bucketStarts({ from: 'nope', to: '2026-06-15T09:00:00.000Z' }, 'day')).toEqual([]);
  });
});

describe('pulseBuckets', () => {
  const window = { from: '2026-06-13T00:00:00.000Z', to: '2026-06-16T00:00:00.000Z' };

  it('sums writes across scopes and splits reads by kind, keeping empty buckets as zeros', () => {
    const buckets = pulseBuckets(
      window,
      'day',
      [write('2026-06-13T00:00:00.000Z', 2, 'global'), write('2026-06-13T00:00:00.000Z', 3, 'repo::a/b')],
      [
        read('2026-06-15T00:00:00.000Z', 40, 'bulk'),
        read('2026-06-15T00:00:00.000Z', 4, 'targeted'),
        read('2026-06-15T00:00:00.000Z', 6, 'bulk', null),
      ],
    );
    expect(buckets).toEqual([
      { start: '2026-06-13T00:00:00.000Z', written: 5, chosen: 0, bulk: 0 },
      { start: '2026-06-14T00:00:00.000Z', written: 0, chosen: 0, bulk: 0 },
      { start: '2026-06-15T00:00:00.000Z', written: 0, chosen: 4, bulk: 46 },
    ]);
  });

  it('counts an untyped (pre-00080) read row as bulk, never as a deliberate fetch', () => {
    const [bucket] = pulseBuckets(window, 'day', [], [read('2026-06-13T00:00:00.000Z', 9)]);
    expect(bucket).toMatchObject({ chosen: 0, bulk: 9 });
  });

  it('ignores rows outside the window rather than misplacing them', () => {
    const buckets = pulseBuckets(window, 'day', [write('2026-06-01T00:00:00.000Z', 7)], []);
    expect(pulseTotals(buckets).written).toBe(0);
  });

  it('bars sum to the totals the strip states', () => {
    const writes = [write('2026-06-13T00:00:00.000Z', 1), write('2026-06-14T00:00:00.000Z', 2)];
    const reads = [read('2026-06-14T00:00:00.000Z', 3, 'targeted'), read('2026-06-15T00:00:00.000Z', 5, 'bulk')];
    expect(pulseTotals(pulseBuckets(window, 'day', writes, reads))).toEqual(rawTotals(writes, reads));
  });
});

describe('periodChange', () => {
  it('omits a delta when the previous window is empty', () => {
    expect(periodChange(0, 0)).toBeNull();
    expect(periodChange(12, 0)).toBeNull();
  });

  it('is a rounded percentage otherwise', () => {
    expect(periodChange(15, 10)).toBe(50);
    expect(periodChange(5, 10)).toBe(-50);
  });
});

describe('loopStages', () => {
  const current = { totals: { written: 12, chosen: 6, bulk: 294 }, summary: { archived: 3, expired: 2 } };
  const previous = { totals: { written: 8, chosen: 2, bulk: 148 }, summary: { archived: 0, expired: 0 } };
  const census = { 'load-bearing': 4, specialist: 7, 'noise-tax': 30, dormant: 11, unproven: 40 };

  it('states each stage from its own source', () => {
    expect(loopStages(current, previous, census)).toEqual({
      learn: { created: 12, changePct: 50 },
      recall: { records: 300, chosen: 6, changePct: 100 },
      promote: { loadBearing: 4, specialist: 7 },
      prune: { archived: 3, expired: 2, changePct: null },
    });
  });

  it('leaves Promote absent while the census has not loaded', () => {
    expect(loopStages(current, previous, null).promote).toBeNull();
  });
});

describe('chosenShare', () => {
  it('is the targeted share of recalled records, or null with no reads', () => {
    expect(chosenShare({ recall: { records: 200, chosen: 5, changePct: null } })).toBe(0.025);
    expect(chosenShare({ recall: { records: 0, chosen: 0, changePct: null } })).toBeNull();
  });
});
