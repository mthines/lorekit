import { describe, it, expect } from 'vitest';
import {
  normalizeTags,
  toggleTag,
  tallyTags,
  pgArrayLiteral,
  tagOptions,
  searchTags,
  tagTriggerLabel,
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


describe('tagOptions', () => {
  const catalog: TagCount[] = [
    { tag: 'perf', count: 5 },
    { tag: 'ci', count: 4 },
  ];

  it('preserves catalog order and does not hoist the selection', () => {
    // A list that reorders on toggle moves the next option out from under the
    // pointer mid-click.
    expect(tagOptions(catalog, ['ci']).map((t) => t.tag)).toEqual(['perf', 'ci']);
  });

  it('appends a selected label the catalog does not cover, with an unknown count', () => {
    expect(tagOptions(catalog, ['flaky'])).toEqual([
      { tag: 'perf', count: 5 },
      { tag: 'ci', count: 4 },
      { tag: 'flaky', count: null },
    ]);
  });

  it('surfaces the whole selection when the catalog is empty or failed', () => {
    expect(tagOptions([], ['perf', 'ci'])).toEqual([
      { tag: 'perf', count: null },
      { tag: 'ci', count: null },
    ]);
  });

  it('never duplicates a selected label that is already catalogued', () => {
    expect(tagOptions(catalog, ['perf', 'ci']).map((t) => t.tag)).toEqual(['perf', 'ci']);
  });
});

describe('searchTags', () => {
  const options: TagCount[] = [
    { tag: 'perf-regression', count: 5 },
    { tag: 'ci/flaky', count: 4 },
    { tag: 'Docs', count: 1 },
  ];

  it('returns everything for a blank or whitespace-only query', () => {
    expect(searchTags(options, '')).toHaveLength(3);
    expect(searchTags(options, '   ')).toHaveLength(3);
  });

  it('matches a substring, not just a prefix', () => {
    expect(searchTags(options, 'regression').map((t) => t.tag)).toEqual(['perf-regression']);
    expect(searchTags(options, 'flaky').map((t) => t.tag)).toEqual(['ci/flaky']);
  });

  it('is case-insensitive in both directions', () => {
    expect(searchTags(options, 'docs').map((t) => t.tag)).toEqual(['Docs']);
    expect(searchTags(options, 'PERF').map((t) => t.tag)).toEqual(['perf-regression']);
  });

  it('matches regex metacharacters literally rather than compiling them', () => {
    expect(searchTags(options, '.*')).toEqual([]);
    expect(searchTags(options, 'ci/')).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchTags(options, 'zzz')).toEqual([]);
  });
});

describe('tagTriggerLabel', () => {
  it('falls back to the dimension name when nothing is selected', () => {
    expect(tagTriggerLabel([])).toBe('Labels');
  });

  it('names the single selected label', () => {
    expect(tagTriggerLabel(['perf'])).toBe('perf');
  });

  it('names the first label and counts the rest', () => {
    expect(tagTriggerLabel(['perf', 'ci', 'flaky'])).toBe('perf +2');
  });

  it('normalizes before summarising so a dirty URL param cannot inflate the count', () => {
    expect(tagTriggerLabel([' perf ', 'perf', ''])).toBe('perf');
  });
});
