import { describe, it, expect } from 'vitest';
import {
  RecordFieldError,
  ATTRIBUTES_MAX_KEYS,
  isMemoryId,
  parseAttributes,
  parseContentType,
  parseRecordFields,
  parseSupersedes,
  splitCitedIds,
  translateRecordFieldDbError,
  compactRecordFields,
} from './record-extensions.js';

const ID = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';

describe('parseAttributes', () => {
  it('returns null when omitted', () => {
    expect(parseAttributes(undefined)).toBeNull();
    expect(parseAttributes(null)).toBeNull();
  });

  it('accepts namespaced keys with scalar values, and null as a removal', () => {
    const attrs = { 'ci.run_url': 'https://ci.example/1', 'vcs.pr': 42, flaky: true, 'old.key': null };
    expect(parseAttributes(attrs)).toEqual(attrs);
  });

  it.each([
    ['an array', ['a']],
    ['a string', 'ci.run_url=x'],
    ['an uppercase key', { 'CI.Run': 'x' }],
    ['a key with a space', { 'ci run': 'x' }],
    ['an empty segment', { 'ci..run': 'x' }],
    ['a nested object value', { 'ci.run': { id: 1 } }],
    ['an array value', { 'ci.run': [1] }],
    ['a non-finite number', { 'ci.run': Number.POSITIVE_INFINITY }],
    ['an over-long value', { 'ci.run': 'x'.repeat(1025) }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseAttributes(input)).toThrow(RecordFieldError);
  });

  it('rejects too many keys', () => {
    const many = Object.fromEntries(Array.from({ length: ATTRIBUTES_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]));
    expect(() => parseAttributes(many)).toThrow(/<= 32 keys/);
  });
});

describe('parseContentType', () => {
  it('returns null when omitted', () => {
    expect(parseContentType(undefined)).toBeNull();
    expect(parseContentType('')).toBeNull();
  });

  it('normalises the two accepted types', () => {
    expect(parseContentType('text/markdown')).toBe('text/markdown');
    expect(parseContentType(' Application/JSON ')).toBe('application/json');
  });

  it('rejects anything else', () => {
    expect(() => parseContentType('text/html')).toThrow(RecordFieldError);
    expect(() => parseContentType(7)).toThrow(RecordFieldError);
  });
});

describe('parseSupersedes / isMemoryId', () => {
  it('accepts a uuid and lowercases it', () => {
    expect(parseSupersedes(ID.toUpperCase())).toBe(ID);
    expect(isMemoryId(ID)).toBe(true);
  });

  it('rejects a scope::key address and other non-ids', () => {
    expect(() => parseSupersedes('global::some-key')).toThrow(RecordFieldError);
    expect(() => parseSupersedes(12)).toThrow(RecordFieldError);
    expect(isMemoryId('global::k')).toBe(false);
  });
});

describe('parseRecordFields', () => {
  it('returns all nulls when nothing is supplied, so the RPC keeps what is stored', () => {
    expect(parseRecordFields({}, 'body')).toEqual({ attributes: null, contentType: null, supersedes: null });
  });

  it('requires a JSON body to parse when the content type says JSON', () => {
    expect(parseRecordFields({ content_type: 'application/json' }, '{"a":1}').contentType).toBe('application/json');
    expect(() => parseRecordFields({ content_type: 'application/json' }, 'not json')).toThrow(/valid JSON/);
  });

  it('does not parse a markdown body', () => {
    expect(parseRecordFields({ content_type: 'text/markdown' }, '{oops').contentType).toBe('text/markdown');
  });
});

describe('splitCitedIds', () => {
  it('separates ids from scope::key references and de-duplicates ids', () => {
    expect(splitCitedIds([ID, 'global::k', ID.toUpperCase(), 7])).toEqual({ ids: [ID], refs: ['global::k', 7] });
  });

  it('treats a non-array as empty', () => {
    expect(splitCitedIds('global::k')).toEqual({ ids: [], refs: [] });
  });
});

describe('translateRecordFieldDbError', () => {
  it('turns the database rejections into user errors', () => {
    const missing = translateRecordFieldDbError({ code: 'P0001', message: `supersedes_not_found: ${ID}` });
    expect(missing).toBeInstanceOf(RecordFieldError);
    expect((missing as Error).message).not.toContain(ID);
    const json = translateRecordFieldDbError({
      code: '23514',
      message: 'new row for relation "memories" violates check constraint "memories_json_value_parses"',
    });
    expect(json).toBeInstanceOf(RecordFieldError);
    const keys = translateRecordFieldDbError({
      code: '23514',
      message: 'new row for relation "memories" violates check constraint "memories_attributes_max_keys"',
    });
    expect((keys as Error).message).toBe('attributes must have <= 32 keys');
  });

  it('passes other errors through unchanged', () => {
    const other = { code: '23505', message: 'duplicate key' };
    expect(translateRecordFieldDbError(other)).toBe(other);
  });
});

describe('compactRecordFields', () => {
  it('leaves out fields that hold their defaults', () => {
    expect(compactRecordFields({ id: ID, value: 'v', attributes: {}, content_type: 'text/markdown', supersedes: null }))
      .toEqual({ id: ID, value: 'v' });
  });

  it('keeps fields that say something', () => {
    const row = { id: ID, attributes: { 'vcs.pr': 4 }, content_type: 'application/json', supersedes: ID };
    expect(compactRecordFields(row)).toEqual(row);
  });
});
