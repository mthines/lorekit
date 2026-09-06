import { describe, it, expect } from 'vitest';
import { isStorableKey, isQueryableKey, unbatchableRefs, groupRefsByScope, missingRefs } from './read-refs.ts';

/** The four characters postgrest-js's `.in()` value list cannot carry safely. */
const STRUCTURAL_KEYS = ['a,b', 'a(b', 'a)b', 'a"b', 'a\\b'];

describe('isStorableKey', () => {
  it('accepts an ordinary key', () => {
    expect(isStorableKey('never-run-nx-fanouts')).toBe(true);
  });

  // `memories.key` is `text not null` with NO charset constraint, and
  // `memory_write` does no filtering — so each of these is genuinely writable
  // and a row carrying it can exist. That is what makes reporting one of them
  // in `missing` a lie rather than a fact.
  it.each(STRUCTURAL_KEYS)('accepts %j — the table would store it', (key) => {
    expect(isStorableKey(key)).toBe(true);
  });

  it('rejects an empty key and one past the 512-char schema bound', () => {
    expect(isStorableKey('')).toBe(false);
    expect(isStorableKey('a'.repeat(512))).toBe(true);
    expect(isStorableKey('a'.repeat(513))).toBe(false);
  });

  it('is total over a non-string', () => {
    // @ts-expect-error — exercising the runtime guard against non-string input
    expect(isStorableKey(42)).toBe(false);
  });
});

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

describe('unbatchableRefs', () => {
  it('returns the storable-but-unbatchable refs, so the transport can query them singly', () => {
    const refs = STRUCTURAL_KEYS.map((key) => ({ scope: 'global', key }));
    expect(unbatchableRefs(refs)).toEqual(refs);
  });

  it('excludes an ordinary key — `groupRefsByScope` already batches it', () => {
    expect(unbatchableRefs([{ scope: 'global', key: 'a' }])).toEqual([]);
  });

  it('excludes a key no row could carry, leaving it for `missingRefs`', () => {
    const refs = [
      { scope: 'global', key: '' },
      { scope: 'global', key: 'a'.repeat(513) },
    ];
    expect(unbatchableRefs(refs)).toEqual([]);
  });

  it('follows request order and keeps the scope verbatim', () => {
    const refs = [
      { scope: 'Repo::Owner/Repo', key: 'z,1' },
      { scope: 'global', key: 'a(2' },
    ];
    expect(unbatchableRefs(refs)).toEqual(refs);
  });

  // The load-bearing one. `missingRefs` claims "these matched nothing", which is
  // only true when every OTHER ref was actually queried. That holds exactly when
  // the two producers PARTITION the storable refs: batched by scope, or singly.
  // A ref falling through both would be reported not-found without anyone having
  // looked — the one class for which `missing` would be a lie.
  it('partitions the storable refs with `groupRefsByScope`, covering every one', () => {
    const refs = [
      { scope: 'global', key: 'plain' },
      { scope: 'global', key: 'has,comma' },
      { scope: 'repo::acme/app', key: 'quo"te' },
      { scope: 'repo::acme/app', key: 'ordinary' },
      { scope: 'global', key: '' }, // not storable — legitimately `missing`
    ];
    const batched = groupRefsByScope(refs).flatMap(({ scope, keys }) => keys.map((key) => `${scope}::${key}`));
    const singles = unbatchableRefs(refs).map(({ scope, key }) => `${scope}::${key}`);

    const storable = refs.filter(({ key }) => isStorableKey(key)).map(({ scope, key }) => `${scope}::${key}`);
    expect([...batched, ...singles].sort()).toEqual([...storable].sort());
    // Disjoint: no ref is queried twice, which would duplicate it in `entries`.
    expect(batched.filter((r) => singles.includes(r))).toEqual([]);
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
