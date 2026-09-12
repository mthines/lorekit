import { describe, expect, it } from 'vitest';

import {
  asMemoryCloseReason,
  clusterSizeBucket,
  rangeTelemetry,
  retentionFilterChange,
  scopeSelectionType,
} from './lore-events';

// A fixed clock, so every relative preset resolves to the same span on every
// run — these functions are clock-injected for exactly this reason.
const NOW = '2026-03-15T12:00:00.000Z';

describe('scopeSelectionType', () => {
  it('reports the TYPE of a scope, never the scope itself', () => {
    expect(scopeSelectionType('repo::mthines/lorekit')).toBe('repo');
    expect(scopeSelectionType('branch::mthines/lorekit::feat/x')).toBe('branch');
    expect(scopeSelectionType('project::lorekit')).toBe('project');
    expect(scopeSelectionType('global')).toBe('global');
  });

  // The Explorer's default. It has to be a VALUE rather than an omitted
  // attribute, or "how many people ever leave All scopes" has no denominator.
  it('gives the all-scopes default a name of its own', () => {
    expect(scopeSelectionType(null)).toBe('all');
  });
});

describe('rangeTelemetry', () => {
  it('passes a preset through and reports its span in days', () => {
    expect(rangeTelemetry({ preset: '24h' }, NOW)).toEqual({ preset: '24h', spanDays: 1 });
    expect(rangeTelemetry({ preset: '7d' }, NOW)).toEqual({ preset: '7d', spanDays: 7 });
    expect(rangeTelemetry({ preset: '90d' }, NOW)).toEqual({ preset: '90d', spanDays: 90 });
  });

  // `all` and an untouched param both resolve to an unbounded window, but they
  // are different facts — one is a choice, the other is a reader who has not
  // made one — so they must not collapse to the same preset value.
  it('keeps an explicit All apart from an untouched param', () => {
    expect(rangeTelemetry({ preset: 'all' }, NOW)).toEqual({ preset: 'all' });
    expect(rangeTelemetry(null, NOW)).toEqual({ preset: 'unset' });
  });

  it('omits spanDays for an unbounded window rather than sending a sentinel', () => {
    expect(rangeTelemetry({ preset: 'all' }, NOW).spanDays).toBeUndefined();
    expect(rangeTelemetry(null, NOW).spanDays).toBeUndefined();
  });

  it('reports an absolute window as custom, with its span', () => {
    expect(rangeTelemetry({ from: '2026-03-01', to: '2026-03-03' }, NOW)).toEqual({
      preset: 'custom',
      spanDays: 3,
    });
  });

  // The legacy day pair is INCLUSIVE of its `to` day. Re-parsing the bounds here
  // instead of going through `resolveRange` would report 2 days for the window
  // above and 0 for the one below — every pre-ISO link off by one.
  it('counts a single-day heatmap selection as one day, not zero', () => {
    expect(rangeTelemetry({ from: '2026-03-01', to: '2026-03-01' }, NOW)).toEqual({
      preset: 'custom',
      spanDays: 1,
    });
  });

  it('rounds a sub-day ISO window up to one day', () => {
    expect(
      rangeTelemetry({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-01T06:00:00.000Z' }, NOW),
    ).toEqual({ preset: 'custom', spanDays: 1 });
  });

  // `?range=` is hand-editable, so a malformed window reaches this function.
  // It must still name the arm it was in rather than throwing on the telemetry
  // path — `track` swallows, but a throw here happens BEFORE track is called.
  it('still reports the arm when the window is unparseable', () => {
    expect(rangeTelemetry({ from: 'nonsense', to: 'also-nonsense' }, NOW)).toEqual({
      preset: 'custom',
    });
    expect(rangeTelemetry({ from: '2026-03-10', to: '2026-03-01' }, NOW)).toEqual({
      preset: 'custom',
    });
  });
});

describe('asMemoryCloseReason', () => {
  it('passes a known reason through', () => {
    expect(asMemoryCloseReason('toggle')).toBe('toggle');
    expect(asMemoryCloseReason('filter-change')).toBe('filter-change');
  });

  // The reason this guard exists: `closeLesson` is handed to JSX as
  // `onClick={onClose}`, so React calls it with a MouseEvent. Without the
  // guard that object becomes the attribute.
  it('degrades a React event object to `dismissed` rather than sending it', () => {
    const syntheticEvent = { type: 'click', bubbles: true, clientX: 42 };
    expect(asMemoryCloseReason(syntheticEvent)).toBe('dismissed');
  });

  it('degrades an unknown string, undefined and null to `dismissed`', () => {
    expect(asMemoryCloseReason('made-up')).toBe('dismissed');
    expect(asMemoryCloseReason(undefined)).toBe('dismissed');
    expect(asMemoryCloseReason(null)).toBe('dismissed');
  });
});

describe('retentionFilterChange', () => {
  it('names the one threshold that was set', () => {
    expect(retentionFilterChange({}, { minAgeDays: 30 })).toEqual({
      action: 'retention-set',
      field: 'minAgeDays',
    });
  });

  it('names the one threshold that was cleared', () => {
    expect(retentionFilterChange({ unseenDays: 14 }, {})).toEqual({
      action: 'retention-remove',
      field: 'unseenDays',
    });
  });

  // `max_opened_count => 0` is a real condition (migration 00105), so a zero
  // must read as SET. A truthiness check here would report it as a removal.
  it('treats a zero threshold as set, not as absent', () => {
    expect(retentionFilterChange({}, { maxOpenedCount: 0 })).toEqual({
      action: 'retention-set',
      field: 'maxOpenedCount',
    });
  });

  it('reports a multi-field clear without guessing at one field', () => {
    expect(retentionFilterChange({ minAgeDays: 30, unseenDays: 14 }, {})).toEqual({
      action: 'retention-remove',
    });
  });

  // The whole reason this returns null: "Clear all" calls the retention setter
  // with `{}` even on a bar that never had a threshold, and emitting there
  // would double-count every filter clear.
  it('returns null when nothing moved, so a no-op write emits nothing', () => {
    expect(retentionFilterChange({}, {})).toBeNull();
    expect(retentionFilterChange({ minAgeDays: 30 }, { minAgeDays: 30 })).toBeNull();
  });
});

describe('clusterSizeBucket', () => {
  it('buckets a member count instead of fingerprinting one cluster', () => {
    expect(clusterSizeBucket(2)).toBe('2');
    expect(clusterSizeBucket(3)).toBe('3-5');
    expect(clusterSizeBucket(5)).toBe('3-5');
    expect(clusterSizeBucket(6)).toBe('6-10');
    expect(clusterSizeBucket(10)).toBe('6-10');
    expect(clusterSizeBucket(11)).toBe('10+');
    expect(clusterSizeBucket(4096)).toBe('10+');
  });
});
