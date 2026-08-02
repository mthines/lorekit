import { describe, it, expect } from 'vitest';
import { normalizeTagList, parseTagsParam, pgArrayLiteral } from './tags.ts';

describe('normalizeTagList', () => {
  it('trims, drops empties, and dedupes preserving first-seen order', () => {
    expect(normalizeTagList([' perf ', 'perf', '', '  ', 'auth'])).toEqual(['perf', 'auth']);
  });

  it('is total for hostile input', () => {
    expect(normalizeTagList(undefined)).toEqual([]);
    expect(normalizeTagList(null)).toEqual([]);
    expect(normalizeTagList(['ok', 1, null, {}] as unknown[])).toEqual(['ok']);
  });
});

describe('parseTagsParam', () => {
  it('splits the comma-separated query param', () => {
    expect(parseTagsParam('perf, auth ,perf')).toEqual(['perf', 'auth']);
  });

  it('returns an empty list for an absent or empty param', () => {
    expect(parseTagsParam(undefined)).toEqual([]);
    expect(parseTagsParam('')).toEqual([]);
    expect(parseTagsParam(' , ')).toEqual([]);
  });
});

describe('pgArrayLiteral', () => {
  it('double-quotes every element', () => {
    expect(pgArrayLiteral(['a', 'b'])).toBe('{"a","b"}');
  });

  it('keeps a comma inside one element instead of splitting it', () => {
    expect(pgArrayLiteral(['a,b'])).toBe('{"a,b"}');
  });

  it('escapes backslashes and quotes', () => {
    expect(pgArrayLiteral(['a"b', 'c\\d'])).toBe('{"a\\"b","c\\\\d"}');
  });

  it('renders an empty selection as an empty array literal', () => {
    expect(pgArrayLiteral([])).toBe('{}');
  });
});
