import { describe, expect, it } from 'vitest';

import {
  PREFERENCE_KEYS,
  UNRESOLVED,
  isResolved,
  parseBooleanPreference,
  parseEnumPreference,
  serializeBooleanPreference,
} from './persisted-preference';

/**
 * These guard the two questions every hand-rolled `localStorage` read in this
 * package used to answer separately: what does an ABSENT value mean, and what
 * does a CORRUPT one mean. Both must mean "the default" — a disclosure
 * preference that read a garbage value as `false` would collapse a panel the
 * viewer never asked to collapse.
 */
describe('parseBooleanPreference', () => {
  it('falls back when the store has not been consulted yet', () => {
    expect(parseBooleanPreference(UNRESOLVED, true)).toBe(true);
    expect(parseBooleanPreference(UNRESOLVED, false)).toBe(false);
  });

  it('falls back when the key is absent', () => {
    // The hook reports an absent key as the empty string, so this is the
    // first-visit path — and it must land on the product default, both ways.
    expect(parseBooleanPreference('', true)).toBe(true);
    expect(parseBooleanPreference('', false)).toBe(false);
  });

  it('reads the canonical spellings', () => {
    expect(parseBooleanPreference('1', false)).toBe(true);
    expect(parseBooleanPreference('0', true)).toBe(false);
  });

  it('also reads the legacy/hand-written spellings, case- and space-insensitively', () => {
    // Tolerant on read so a value written by an older build, or typed into a
    // devtools console, still resolves instead of silently reading as false.
    expect(parseBooleanPreference('true', false)).toBe(true);
    expect(parseBooleanPreference(' TRUE ', false)).toBe(true);
    expect(parseBooleanPreference('False', true)).toBe(false);
  });

  it('falls back on anything it does not recognise', () => {
    for (const raw of ['maybe', '2', '[]', 'null', 'undefined']) {
      expect(parseBooleanPreference(raw, true)).toBe(true);
      expect(parseBooleanPreference(raw, false)).toBe(false);
    }
  });

  it('round-trips what it serialises', () => {
    for (const value of [true, false]) {
      expect(parseBooleanPreference(serializeBooleanPreference(value), !value)).toBe(value);
    }
  });

  it('serialises canonically, never as "true"/"false"', () => {
    expect(serializeBooleanPreference(true)).toBe('1');
    expect(serializeBooleanPreference(false)).toBe('0');
  });
});

describe('parseEnumPreference', () => {
  const VIEWS = ['charts', 'heatmap'] as const;

  it('accepts a member of the closed set', () => {
    expect(parseEnumPreference('heatmap', VIEWS, 'charts')).toBe('heatmap');
  });

  it('trims surrounding whitespace', () => {
    expect(parseEnumPreference('  heatmap  ', VIEWS, 'charts')).toBe('heatmap');
  });

  it('falls back for a value that is no longer part of the vocabulary', () => {
    // The version-skew case: a preference written by a build that offered a
    // third view must degrade to the default rather than putting the UI into a
    // state it can no longer render.
    expect(parseEnumPreference('sparklines', VIEWS, 'charts')).toBe('charts');
  });

  it('falls back for absent and unresolved', () => {
    expect(parseEnumPreference('', VIEWS, 'charts')).toBe('charts');
    expect(parseEnumPreference(UNRESOLVED, VIEWS, 'heatmap')).toBe('heatmap');
  });

  it('is case-SENSITIVE, because the vocabulary is', () => {
    // Unlike the boolean codec: an enum member is an identifier the app compares
    // by value, so silently accepting a different casing would let two spellings
    // of one member exist.
    expect(parseEnumPreference('Heatmap', VIEWS, 'charts')).toBe('charts');
  });
});

describe('isResolved', () => {
  it('separates "not consulted yet" from "absent"', () => {
    // The distinction the whole no-flash guarantee rests on.
    expect(isResolved(UNRESOLVED)).toBe(false);
    expect(isResolved('')).toBe(true);
    expect(isResolved('0')).toBe(true);
  });
});

describe('PREFERENCE_KEYS', () => {
  it('namespaces every key so nothing else on the origin can collide', () => {
    const keys = Object.values(PREFERENCE_KEYS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.startsWith('lorekit:')).toBe(true);
  });

  it('has no duplicate spellings', () => {
    // A writer and a reader disagreeing by one character is a bug that looks
    // exactly like "persistence doesn't work".
    const keys = Object.values(PREFERENCE_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
