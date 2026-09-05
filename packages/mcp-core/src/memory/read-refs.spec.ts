import { describe, it, expect } from 'vitest';
import { isQueryableKey, groupRefsByScope, missingRefs } from './read-refs.ts';

describe('isQueryableKey', () => {
  it('accepts an ordinary key', () => {
    expect(isQueryableKey('never-run-nx-fanouts')).toBe(true);
  });

  // AC-11: a key containing a character that is structural in a PostgREST
  // `.in(…)` filter list must be rejected before it reaches a query.
  it.each([
    ['comma', 'a,b'],
    ['open paren', 'a(b'],
    ['close paren', 'a)b'],
    ['double quote', 'a"b'],
    ['backslash', 'a\\b'],
  ])('rejects a key containing a %s', (_label, key) => {
    expect(isQueryableKey(key)).toBe(false);
  });

  it('rejects a key over the length limit', () => {
    expect(isQueryableKey('a'.repeat(512))).toBe(true);
    expect(isQueryableKey('a'.repeat(513))).toBe(false);
  });

  it('rejects an empty key', () => {
    expect(isQueryableKey('')).toBe(false);
  });

  it('is total over a non-string', () => {
    // @ts-expect-error — exercising the runtime guard against non-string input
    expect(isQueryableKey(42)).toBe(false);
  });
});

describe('groupRefsByScope', () => {
  it('groups refs sharing a scope into one entry, ordered by first occurrence', () => {
    const refs = [
      { scope: 'global', key: 'a' },
      { scope: 'repo::acme/app', key: 'x' },
      { scope: 'global', key: 'b' },
    ];
    expect(groupRefsByScope(refs)).toEqual([
      { scope: 'global', keys: ['a', 'b'] },
      { scope: 'repo::acme/app', keys: ['x'] },
    ]);
  });

  it('drops a ref whose key is not queryable, from every group', () => {
    const refs = [
      { scope: 'global', key: 'a' },
      { scope: 'global', key: 'bad,key' },
    ];
    expect(groupRefsByScope(refs)).toEqual([{ scope: 'global', keys: ['a'] }]);
  });

  it('returns no groups for an empty input', () => {
    expect(groupRefsByScope([])).toEqual([]);
  });

  it('preserves the caller-supplied scope verbatim (no lowercasing)', () => {
    const refs = [{ scope: 'Repo::Owner/Repo', key: 'x' }];
    expect(groupRefsByScope(refs)).toEqual([{ scope: 'Repo::Owner/Repo', keys: ['x'] }]);
  });
});

describe('missingRefs', () => {
  it('returns the requested refs not present in found, as scope::key strings', () => {
    const requested = [
      { scope: 'global', key: 'a' },
      { scope: 'repo::acme/app', key: 'x' },
    ];
    const found = [{ scope: 'global', key: 'a' }];
    expect(missingRefs(requested, found)).toEqual(['repo::acme/app::x']);
  });

  it('returns an empty array when every ref was found', () => {
    const requested = [{ scope: 'global', key: 'a' }];
    expect(missingRefs(requested, requested)).toEqual([]);
  });

  it('returns every ref when nothing was found', () => {
    const requested = [
      { scope: 'global', key: 'a' },
      { scope: 'global', key: 'b' },
    ];
    expect(missingRefs(requested, [])).toEqual(['global::a', 'global::b']);
  });

  it('matches scope and key exactly, case-sensitively', () => {
    const requested = [{ scope: 'Global', key: 'a' }];
    const found = [{ scope: 'global', key: 'a' }];
    expect(missingRefs(requested, found)).toEqual(['Global::a']);
  });
});
