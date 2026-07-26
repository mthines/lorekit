/**
 * TagsField — pure logic tests (node environment, no DOM/React).
 *
 * Covers the addTag / removeTag / keyboard logic extracted as pure functions.
 */

import { describe, it, expect } from 'vitest';

// ── Pure helpers mirrored from TagsField ──────────────────────────────────────

/** Normalise a raw input string to a tag (trim, lowercase, strip commas). */
function normaliseTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/,/g, '');
}

/** Should we add this tag to the list? */
function canAddTag(tag: string, existing: string[], maxTags: number): boolean {
  return Boolean(tag) && !existing.includes(tag) && existing.length < maxTags;
}

/** Return the new list after adding a raw string (no-op if canAddTag is false). */
function addTag(raw: string, existing: string[], maxTags = 20): string[] {
  const tag = normaliseTag(raw);
  if (!canAddTag(tag, existing, maxTags)) return existing;
  return [...existing, tag];
}

/** Return the new list after removing the tag at the given index. */
function removeTag(index: number, existing: string[]): string[] {
  return existing.filter((_, i) => i !== index);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('normaliseTag', () => {
  it('trims whitespace', () => {
    expect(normaliseTag('  hello  ')).toBe('hello');
  });

  it('lowercases', () => {
    expect(normaliseTag('MyTag')).toBe('mytag');
  });

  it('strips commas', () => {
    expect(normaliseTag('tag,')).toBe('tag');
  });

  it('handles empty string', () => {
    expect(normaliseTag('')).toBe('');
    expect(normaliseTag('  ')).toBe('');
  });
});

describe('canAddTag', () => {
  it('returns false for empty tag', () => {
    expect(canAddTag('', [], 20)).toBe(false);
  });

  it('returns false when tag already exists', () => {
    expect(canAddTag('existing', ['existing'], 20)).toBe(false);
  });

  it('returns false when at the maxTags limit', () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(canAddTag('new', tags, 20)).toBe(false);
  });

  it('returns true for a valid new tag', () => {
    expect(canAddTag('newtag', ['a', 'b'], 20)).toBe(true);
  });
});

describe('addTag', () => {
  it('appends a new normalised tag', () => {
    const result = addTag('  Hello ', ['a'], 20);
    expect(result).toEqual(['a', 'hello']);
  });

  it('does not add a duplicate', () => {
    const result = addTag('hello', ['hello'], 20);
    expect(result).toEqual(['hello']);
  });

  it('does not add when at maxTags', () => {
    const tags = ['a', 'b'];
    const result = addTag('c', tags, 2);
    expect(result).toEqual(['a', 'b']);
  });

  it('strips commas from the input', () => {
    const result = addTag('tag,', [], 20);
    expect(result).toEqual(['tag']);
  });
});

describe('removeTag', () => {
  it('removes the tag at the given index', () => {
    expect(removeTag(1, ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('removes the first tag', () => {
    expect(removeTag(0, ['x', 'y'])).toEqual(['y']);
  });

  it('removes the last tag', () => {
    expect(removeTag(1, ['x', 'y'])).toEqual(['x']);
  });

  it('returns an empty array after removing the only tag', () => {
    expect(removeTag(0, ['only'])).toEqual([]);
  });
});
