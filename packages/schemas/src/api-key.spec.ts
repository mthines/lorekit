import { describe, it, expect } from 'vitest';
import type { ApiKeyOrgAccess } from './api-key.ts';
import {
  API_KEY_MAX_ORGS,
  API_KEY_MAX_SCOPES,
  ApiKeyScopingSchema,
  UNSCOPED_API_KEY,
  isScopedKey,
  orgAllowedByKey,
  scopeAllowedByKey,
} from './api-key.ts';

describe('scopeAllowedByKey', () => {
  it('does not honour a MID-TOKEN wildcard as a prefix', () => {
    // `SCOPE_PATTERN` puts `*` directly after `/` or `::` and nowhere else, so
    // `repo::mthines/lore*` is malformed. Honouring it as a prefix would widen
    // the key to every repo starting with those letters — the one direction
    // this predicate must never move. It matches only itself instead, which is
    // the same non-widening answer `keyScopeFilter` and the SQL twin give.
    const patterns = ['repo::mthines/lore*'];
    expect(scopeAllowedByKey(patterns, 'repo::mthines/lorekit')).toBe(false);
    expect(scopeAllowedByKey(patterns, 'repo::mthines/lore-other')).toBe(false);
    // The two legal wildcard positions still expand.
    expect(scopeAllowedByKey(['repo::mthines/*'], 'repo::mthines/lorekit')).toBe(true);
    expect(scopeAllowedByKey(['project::*'], 'project::alpha')).toBe(true);
  });

  it('allows everything when the allowlist is empty', () => {
    // Migration 00067 decision 1: empty = unrestricted, so every key that
    // existed before scoping keeps working untouched.
    expect(scopeAllowedByKey([], 'repo::mthines/lorekit')).toBe(true);
    expect(scopeAllowedByKey([], 'global')).toBe(true);
  });

  it('matches an exact scope and nothing else', () => {
    const patterns = ['repo::mthines/lorekit'];
    expect(scopeAllowedByKey(patterns, 'repo::mthines/lorekit')).toBe(true);
    expect(scopeAllowedByKey(patterns, 'repo::mthines/gw-tools')).toBe(false);
    // A prefix of an exact pattern is NOT a match — otherwise every allowlist
    // would silently widen to its own prefixes.
    expect(scopeAllowedByKey(patterns, 'repo::mthines')).toBe(false);
  });

  it('matches an owner wildcard by prefix', () => {
    const patterns = ['repo::mthines/*'];
    expect(scopeAllowedByKey(patterns, 'repo::mthines/lorekit')).toBe(true);
    expect(scopeAllowedByKey(patterns, 'repo::mthines/anything-at-all')).toBe(true);
    expect(scopeAllowedByKey(patterns, 'repo::someone-else/lorekit')).toBe(false);
  });

  it('keeps an underscore in a wildcard prefix literal', () => {
    // The SQL twin escapes `_` because it is LIKE's single-character wildcard.
    // This is the case that proves the two implementations agree: without the
    // escape, `repo::my_org/*` would also match `repo::myXorg/...`.
    const patterns = ['repo::my_org/*'];
    expect(scopeAllowedByKey(patterns, 'repo::my_org/lorekit')).toBe(true);
    expect(scopeAllowedByKey(patterns, 'repo::myXorg/lorekit')).toBe(false);
  });

  it('is an OR across patterns', () => {
    const patterns = ['global', 'repo::mthines/*'];
    expect(scopeAllowedByKey(patterns, 'global')).toBe(true);
    expect(scopeAllowedByKey(patterns, 'repo::mthines/lorekit')).toBe(true);
    expect(scopeAllowedByKey(patterns, 'project::other')).toBe(false);
  });

  it('refuses a scopeless operation on a restricted key', () => {
    // `memory.purge_expired` and the account-wide reads carry no scope. A key
    // narrowed to one repo must not be able to sweep the whole account, so the
    // unmatched case fails closed.
    expect(scopeAllowedByKey(['repo::mthines/*'], null)).toBe(false);
  });

  it('still allows a scopeless operation on an UNRESTRICTED key', () => {
    // Otherwise scoping would change behaviour for keys nobody scoped.
    expect(scopeAllowedByKey([], null)).toBe(true);
  });
});

describe('orgAllowedByKey', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';

  it('always allows a personal row, under every tenancy', () => {
    // `personal` narrows which ORGS are reachable; it never revokes the owner's
    // own memories.
    expect(orgAllowedByKey('all', [], null)).toBe(true);
    expect(orgAllowedByKey('personal', [], null)).toBe(true);
    expect(orgAllowedByKey('selected', [ORG_A], null)).toBe(true);
  });

  it('allows every org under "all"', () => {
    expect(orgAllowedByKey('all', [], ORG_A)).toBe(true);
  });

  it('refuses every org under "personal"', () => {
    expect(orgAllowedByKey('personal', [], ORG_A)).toBe(false);
  });

  it('allows only the listed orgs under "selected"', () => {
    expect(orgAllowedByKey('selected', [ORG_A], ORG_A)).toBe(true);
    expect(orgAllowedByKey('selected', [ORG_A], ORG_B)).toBe(false);
  });

  it('fails CLOSED on a tenancy it does not recognise', () => {
    // Reachable only if the DB CHECK is dropped or a BYOD install predates it.
    // The SQL twin has the same `else false`, and migrations.test.sql §81 AC-3
    // asserts it — this is the TypeScript half of that pair.
    expect(orgAllowedByKey('nonsense' as ApiKeyOrgAccess, [ORG_A], ORG_A)).toBe(false);
  });
});

describe('ApiKeyScopingSchema', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';

  it('defaults to unrestricted', () => {
    expect(ApiKeyScopingSchema.parse({})).toEqual(UNSCOPED_API_KEY);
  });

  it('lowercases and trims a pattern', () => {
    const parsed = ApiKeyScopingSchema.parse({ scopes: ['  Repo::MThines/LoreKit '] });
    expect(parsed.scopes).toEqual(['repo::mthines/lorekit']);
  });

  it('accepts an owner wildcard, which is not a legal scope', () => {
    // `ScopeSchema` would reject this, which is exactly why a pattern has its
    // own shape-only schema rather than reusing the scope one.
    expect(ApiKeyScopingSchema.parse({ scopes: ['repo::mthines/*'] }).scopes).toEqual([
      'repo::mthines/*',
    ]);
  });

  it('rejects a pattern outside the injection-guard charset', () => {
    // The same charset `expandScopeForSearch` guards, for the same reason: the
    // value ends up in a PostgREST filter where `,` `(` `)` are grammar.
    expect(() => ApiKeyScopingSchema.parse({ scopes: ['a,value.not.is.null'] })).toThrow();
    expect(() => ApiKeyScopingSchema.parse({ scopes: ['scope.eq.x)or(y'] })).toThrow();
  });

  it('rejects an interior wildcard', () => {
    // Only a TRAILING `*` is a wildcard; anything else would need a second
    // matcher that the SQL twin does not have.
    expect(() => ApiKeyScopingSchema.parse({ scopes: ['repo::*/lorekit'] })).toThrow();
  });

  it('rejects a trailing wildcard that is not on a segment boundary', () => {
    // The case that distinguishes this grammar from "any trailing star":
    // `repo::mthines/lore*` would allowlist `repo::mthines/lorekit-private`
    // while being refused as a search filter by `expandScopeForSearch`. Only
    // `/` and `::` may precede the star, exactly as that function requires.
    expect(() => ApiKeyScopingSchema.parse({ scopes: ['repo::mthines/lore*'] })).toThrow();
    expect(() => ApiKeyScopingSchema.parse({ scopes: ['globa*'] })).toThrow();
    expect(ApiKeyScopingSchema.parse({ scopes: ['repo::mthines/*'] }).scopes).toEqual([
      'repo::mthines/*',
    ]);
    expect(ApiKeyScopingSchema.parse({ scopes: ['project::*'] }).scopes).toEqual(['project::*']);
  });

  it('bounds both lists', () => {
    const many = Array.from({ length: API_KEY_MAX_SCOPES + 1 }, (_, i) => `project::p${i}`);
    expect(() => ApiKeyScopingSchema.parse({ scopes: many })).toThrow();
    const manyOrgs = Array.from({ length: API_KEY_MAX_ORGS + 1 }, () => ORG);
    expect(() =>
      ApiKeyScopingSchema.parse({ orgAccess: 'selected', orgIds: manyOrgs }),
    ).toThrow();
  });

  it('requires org ids for "selected"', () => {
    expect(() => ApiKeyScopingSchema.parse({ orgAccess: 'selected' })).toThrow();
  });

  it('refuses org ids that the tenancy does not use', () => {
    // A `personal` key carrying org ids reads as granted access and is not —
    // the worst failure mode an authorization record has.
    expect(() => ApiKeyScopingSchema.parse({ orgAccess: 'personal', orgIds: [ORG] })).toThrow();
    expect(() => ApiKeyScopingSchema.parse({ orgAccess: 'all', orgIds: [ORG] })).toThrow();
  });
});

describe('isScopedKey', () => {
  it('reports the default as unscoped', () => {
    expect(isScopedKey(UNSCOPED_API_KEY)).toBe(false);
  });

  it('reports either axis alone as scoped', () => {
    expect(isScopedKey({ ...UNSCOPED_API_KEY, scopes: ['global'] })).toBe(true);
    expect(isScopedKey({ ...UNSCOPED_API_KEY, orgAccess: 'personal' })).toBe(true);
  });
});
