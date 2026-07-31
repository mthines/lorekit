import { describe, it, expect } from 'vitest';
import {
  normalizeTags,
  toggleTag,
  tallyTags,
  pgArrayLiteral,
  visibleTags,
  type TagCount,
} from './tag-filter';

describe('normalizeTags', () => {
  it('returns an empty list for absent or non-array input', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags('perf' as unknown as string[])).toEqual([]);
  });

  it('trims, drops empties, and dedupes while preserving first-seen order', () => {
    expect(normalizeTags([' perf ', 'perf', '', '   ', 'regression'])).toEqual([
      'perf',
      'regression',
    ]);
  });

  it('skips non-string members instead of throwing', () => {
    expect(normalizeTags(['perf', 42, null, { tag: 'x' }, 'ci'])).toEqual(['perf', 'ci']);
  });
});

describe('toggleTag', () => {
  it('adds an unselected label', () => {
    expect(toggleTag(['perf'], 'ci')).toEqual(['perf', 'ci']);
  });

  it('removes a selected label', () => {
    expect(toggleTag(['perf', 'ci'], 'perf')).toEqual(['ci']);
  });

  it('matches on the trimmed label so whitespace never duplicates a chip', () => {
    expect(toggleTag(['perf'], ' perf ')).toEqual([]);
  });

  it('is a no-op for an empty label', () => {
    expect(toggleTag(['perf'], '   ')).toEqual(['perf']);
  });

  it('normalizes a dirty incoming selection', () => {
    expect(toggleTag([' perf ', 'perf', ''], 'ci')).toEqual(['perf', 'ci']);
  });
});

describe('tallyTags', () => {
  it('counts labels across rows', () => {
    expect(
      tallyTags([{ tags: ['perf', 'ci'] }, { tags: ['perf'] }, { tags: ['perf', 'ci'] }]),
    ).toEqual([
      { tag: 'perf', count: 3 },
      { tag: 'ci', count: 2 },
    ]);
  });

  it('sorts equal counts alphabetically so the bar does not reshuffle', () => {
    expect(tallyTags([{ tags: ['zebra'] }, { tags: ['alpha'] }])).toEqual([
      { tag: 'alpha', count: 1 },
      { tag: 'zebra', count: 1 },
    ]);
  });

  it('tolerates rows with missing or null tags', () => {
    expect(tallyTags([{}, { tags: null }, { tags: ['perf'] }])).toEqual([
      { tag: 'perf', count: 1 },
    ]);
  });

  it('counts a duplicated label on one row once', () => {
    expect(tallyTags([{ tags: ['perf', 'perf'] }])).toEqual([{ tag: 'perf', count: 1 }]);
  });
});

describe('pgArrayLiteral', () => {
  it('double-quotes every element', () => {
    expect(pgArrayLiteral(['perf', 'ci'])).toBe('{"perf","ci"}');
  });

  it('keeps a label containing a comma as ONE label', () => {
    // The bug this function exists for: postgrest-js's array path emits
    // `cs.{perf,ci}` via a bare join, so `perf,ci` would filter as two labels.
    expect(pgArrayLiteral(['perf,ci'])).toBe('{"perf,ci"}');
  });

  it('escapes backslashes and double quotes', () => {
    expect(pgArrayLiteral(['a"b'])).toBe('{"a\\"b"}');
    expect(pgArrayLiteral(['a\\b'])).toBe('{"a\\\\b"}');
  });

  it('passes braces through inside the quoted element', () => {
    expect(pgArrayLiteral(['{ci}'])).toBe('{"{ci}"}');
  });

  it('normalizes before quoting and renders an empty selection as `{}`', () => {
    expect(pgArrayLiteral([' perf ', 'perf', ''])).toBe('{"perf"}');
    expect(pgArrayLiteral([])).toBe('{}');
  });
});

describe('visibleTags', () => {
  const catalog: TagCount[] = [
    { tag: 'a', count: 5 },
    { tag: 'b', count: 4 },
    { tag: 'c', count: 3 },
    { tag: 'd', count: 2 },
  ];

  it('caps the bar at `limit`', () => {
    expect(visibleTags(catalog, [], 2).map((t) => t.tag)).toEqual(['a', 'b']);
  });

  it('pins a selected label that falls outside the cap so it stays removable', () => {
    expect(visibleTags(catalog, ['d'], 2).map((t) => t.tag)).toEqual(['a', 'b', 'd']);
  });

  it('never duplicates a selected label that is already inside the cap', () => {
    expect(visibleTags(catalog, ['a'], 2).map((t) => t.tag)).toEqual(['a', 'b']);
  });

  it('carries a selected label the catalog does not know with an unknown count', () => {
    // An empty/failed catalog must still surface the active chips, otherwise a
    // shared `?tags=` link filters with no way to switch the filter off.
    expect(visibleTags([], ['perf', 'ci'], 12)).toEqual([
      { tag: 'perf', count: null },
      { tag: 'ci', count: null },
    ]);
  });

  it('still surfaces the selection when the cap is non-positive', () => {
    expect(visibleTags(catalog, ['a'], 0)).toEqual([{ tag: 'a', count: 5 }]);
  });

  it('returns nothing when there is no catalog and no selection', () => {
    expect(visibleTags([], [], 0)).toEqual([]);
  });
});
