import { describe, expect, it } from 'vitest';
import { parseFlagOverrides, serializeFlagOverrides, withFlagOverrides } from './overrides.ts';
import type { FlagDefinition } from './schema.ts';

const registry: readonly FlagDefinition[] = [
  {
    key: 'my-flag',
    description: 'test',
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: [],
  },
];

describe('parseFlagOverrides', () => {
  it('returns an empty map for undefined/null/empty input', () => {
    expect(parseFlagOverrides(undefined)).toEqual({});
    expect(parseFlagOverrides(null)).toEqual({});
    expect(parseFlagOverrides('')).toEqual({});
  });

  it('returns an empty map for malformed JSON — never throws', () => {
    expect(() => parseFlagOverrides('{not json')).not.toThrow();
    expect(parseFlagOverrides('{not json')).toEqual({});
  });

  it('rejects a non-object JSON value (array, string, number)', () => {
    expect(parseFlagOverrides('[]', registry)).toEqual({});
    expect(parseFlagOverrides('"on"', registry)).toEqual({});
    expect(parseFlagOverrides('42', registry)).toEqual({});
  });

  it('accepts a valid override for a known flag and variant', () => {
    expect(parseFlagOverrides(JSON.stringify({ 'my-flag': 'on' }), registry)).toEqual({
      'my-flag': 'on',
    });
  });

  it('drops an entry for an unknown flag key', () => {
    expect(parseFlagOverrides(JSON.stringify({ 'not-a-flag': 'on' }), registry)).toEqual({});
  });

  it('drops an entry whose variant does not exist for that flag', () => {
    expect(parseFlagOverrides(JSON.stringify({ 'my-flag': 'nonexistent' }), registry)).toEqual({});
  });

  it('drops a non-string value without dropping the rest of the map', () => {
    const raw = JSON.stringify({ 'my-flag': 'on', other: 123 });
    expect(parseFlagOverrides(raw, registry)).toEqual({ 'my-flag': 'on' });
  });

  it('rejects a variant name reached only via the prototype chain (constructor, toString)', () => {
    // Regression guard for the `in`-vs-`Object.hasOwn` class of bug fixed in
    // schema.ts / provider.ts — this module must not inherit it.
    expect(parseFlagOverrides(JSON.stringify({ 'my-flag': 'constructor' }), registry)).toEqual({});
  });
});

describe('serializeFlagOverrides / parseFlagOverrides round-trip', () => {
  it('round-trips a valid override map', () => {
    const overrides = { 'my-flag': 'on' };
    expect(parseFlagOverrides(serializeFlagOverrides(overrides), registry)).toEqual(overrides);
  });
});

describe('withFlagOverrides', () => {
  it('adds the overrides under the reserved context key without mutating the input', () => {
    const context = { targetingKey: 'user-1' };
    const result = withFlagOverrides(context, { 'my-flag': 'on' });
    expect(result).toEqual({ targetingKey: 'user-1', flagOverrides: { 'my-flag': 'on' } });
    expect(context).toEqual({ targetingKey: 'user-1' });
  });
});
