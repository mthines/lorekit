import { describe, it, expect } from 'vitest';
import {
  normalizeTagList,
  parseTagsParam,
  pgArrayLiteral,
  inferKindHost,
  resolveKindHost,
} from './tags.ts';

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

describe('inferKindHost', () => {
  it('maps a loop lessons tag to lesson + host', () => {
    expect(inferKindHost(['loop::reviewer-lessons'])).toEqual({ kind: 'lesson', host: 'reviewer' });
    expect(inferKindHost(['loop::aw-lessons'])).toEqual({ kind: 'lesson', host: 'aw' });
  });

  it('maps the two named non-lesson buckets to bus / signal', () => {
    expect(inferKindHost(['loop::review-outcomes'])).toEqual({ kind: 'bus', host: 'review' });
    expect(inferKindHost(['loop::reviewer-comment-relevance'])).toEqual({
      kind: 'signal',
      host: 'reviewer',
    });
  });

  it('returns {} for an absent, non-loop, or malformed tag set', () => {
    expect(inferKindHost(undefined)).toEqual({});
    expect(inferKindHost(['source::stuck-loop', 'perf'])).toEqual({});
    expect(inferKindHost([123, null])).toEqual({});
  });

  it('lets the first recognised loop tag win', () => {
    expect(inferKindHost(['perf', 'loop::fix-bug-lessons', 'loop::aw-lessons'])).toEqual({
      kind: 'lesson',
      host: 'fix-bug',
    });
  });
});

describe('resolveKindHost', () => {
  it('prefers an explicit, valid kind/host over the tag', () => {
    expect(
      resolveKindHost({ kind: 'signal', host: 'custom', tags: ['loop::aw-lessons'] }),
    ).toEqual({ kind: 'signal', host: 'custom' });
  });

  it('falls back to inference when explicit values are absent', () => {
    expect(resolveKindHost({ tags: ['loop::reviewer-lessons'] })).toEqual({
      kind: 'lesson',
      host: 'reviewer',
    });
  });

  it('ignores an explicit kind outside the closed vocabulary', () => {
    expect(resolveKindHost({ kind: 'nonsense', tags: ['loop::review-outcomes'] })).toEqual({
      kind: 'bus',
      host: 'review',
    });
  });

  it('returns nulls when neither explicit nor inferable', () => {
    expect(resolveKindHost({ tags: ['perf'] })).toEqual({ kind: null, host: null });
    expect(resolveKindHost({})).toEqual({ kind: null, host: null });
  });
});
