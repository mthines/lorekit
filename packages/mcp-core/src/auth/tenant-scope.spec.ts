import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  applyTenantScope,
  effectiveOrgIds,
  keyScopeFilter,
  normalizeKeyRestriction,
  ownRowsFragment,
  restrictsTenancy,
} from './tenant-scope.js';

interface FakeQuery {
  eq: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeQuery(): FakeQuery {
  const query = {} as FakeQuery;
  query.eq = vi.fn().mockReturnValue(query);
  query.or = vi.fn().mockReturnValue(query);
  return query;
}

describe('applyTenantScope', () => {
  it('empty orgIds: returns a personal-only filter, never touching .or()', () => {
    const query = fakeQuery();
    const result = applyTenantScope(query, 'user-1', []);
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.or).not.toHaveBeenCalled();
    expect(result).toBe(query);
  });

  it('non-empty orgIds: widens to personal + member-org rows via one .or() filter', () => {
    const query = fakeQuery();
    const result = applyTenantScope(query, 'user-1', ['org-a', 'org-b']);
    expect(query.or).toHaveBeenCalledWith('user_id.eq.user-1,org_id.in.("org-a","org-b")');
    expect(query.eq).not.toHaveBeenCalled();
    expect(result).toBe(query);
  });

  it('single org id: emits a one-element org_id.in.() list', () => {
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a']);
    expect(query.or).toHaveBeenCalledWith('user_id.eq.user-1,org_id.in.("org-a")');
  });

  it('total function: an empty orgIds list never emits an org_id.in.() fragment', () => {
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', []);
    const orFragments = query.or.mock.calls.map((call) => call[0] as string);
    expect(orFragments.some((f) => f.includes('org_id.in.()'))).toBe(false);
  });
});

describe('normalizeKeyRestriction', () => {
  it('reads a well-formed row', () => {
    expect(
      normalizeKeyRestriction({ scopes: ['global'], org_access: 'selected', org_ids: ['org-a'] }),
    ).toEqual({ scopes: ['global'], orgAccess: 'selected', orgIds: ['org-a'] });
  });

  it('treats an ABSENT org_access as unrestricted', () => {
    // That is the pre-00068 row shape — the column did not exist — and every
    // key created before scoping is unrestricted by definition.
    expect(normalizeKeyRestriction({}).orgAccess).toBe('all');
    expect(normalizeKeyRestriction({ org_access: null }).orgAccess).toBe('all');
  });

  it('fails CLOSED on an org_access it does not recognise', () => {
    // Present-but-unrecognised is corruption (the CHECK dropped, or a BYOD
    // install predating it). "I do not understand this restriction" must not
    // resolve to "there is no restriction", so it lands on the NARROWEST value.
    expect(normalizeKeyRestriction({ org_access: 'everything' }).orgAccess).toBe('personal');
    expect(normalizeKeyRestriction({ org_access: 42 }).orgAccess).toBe('personal');
  });

  it('degrades an unreadable scopes column to unrestricted, not to deny-all', () => {
    // The opposite direction from org_access, deliberately: empty IS the
    // default for every key ever created, so treating an unreadable value as
    // "deny everything" would brick unscoped keys on a read hiccup.
    expect(normalizeKeyRestriction({ scopes: 'not-an-array' }).scopes).toEqual([]);
  });

  it('drops non-string members rather than carrying them into a filter', () => {
    expect(normalizeKeyRestriction({ scopes: ['global', 7, null] }).scopes).toEqual(['global']);
    expect(normalizeKeyRestriction({ org_access: 'selected', org_ids: ['a', 1] }).orgIds).toEqual(['a']);
  });
});

describe('effectiveOrgIds', () => {
  it('is a no-op without a key, and under "all"', () => {
    expect(effectiveOrgIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(effectiveOrgIds(['a', 'b'], { scopes: [], orgAccess: 'all', orgIds: [] })).toEqual(['a', 'b']);
  });

  it('drops every org under "personal"', () => {
    expect(effectiveOrgIds(['a', 'b'], { scopes: [], orgAccess: 'personal', orgIds: [] })).toEqual([]);
  });

  it('INTERSECTS under "selected" rather than substituting the key list', () => {
    // The discriminating case: `c` is on the key but the owner is no longer a
    // member. Returning the key's list verbatim would let a stale row keep
    // granting access — exactly the drift the single membership predicate
    // exists to prevent.
    expect(
      effectiveOrgIds(['a', 'b'], { scopes: [], orgAccess: 'selected', orgIds: ['a', 'c'] }),
    ).toEqual(['a']);
  });
});

describe('keyScopeFilter', () => {
  it('returns null when there is nothing to add', () => {
    // Not a match-everything fragment: successive .or() calls are ANDed, so an
    // always-true fragment is dead weight on nearly every query.
    expect(keyScopeFilter()).toBeNull();
    expect(keyScopeFilter({ scopes: [], orgAccess: 'all', orgIds: [] })).toBeNull();
  });

  it('emits an eq for an exact pattern and a like for a wildcard', () => {
    expect(keyScopeFilter({ scopes: ['global'], orgAccess: 'all', orgIds: [] })).toBe('scope.eq.global');
    expect(keyScopeFilter({ scopes: ['repo::mthines/*'], orgAccess: 'all', orgIds: [] })).toBe(
      'scope.like.repo::mthines/%',
    );
  });

  it('escapes an underscore in a wildcard prefix', () => {
    // `_` is LIKE's single-character wildcard; unescaped, `repo::my_org/*` would
    // also match `repo::myXorg/…`. Same escape as expandScopeForSearch.
    expect(keyScopeFilter({ scopes: ['repo::my_org/*'], orgAccess: 'all', orgIds: [] })).toBe(
      'scope.like.repo::my\\_org/%',
    );
  });

  it('joins several patterns with a comma', () => {
    expect(
      keyScopeFilter({ scopes: ['global', 'repo::mthines/*'], orgAccess: 'all', orgIds: [] }),
    ).toBe('scope.eq.global,scope.like.repo::mthines/%');
  });

  it('DROPS a pattern that could inject into the filter grammar', () => {
    // `,` `(` `)` are PostgREST grammar. The DB CHECK rejects these at write
    // time; this is the second line, and it drops rather than escapes because
    // dropping can only ever narrow what the key reaches.
    expect(
      keyScopeFilter({
        scopes: ['global', 'a,value.not.is.null'],
        orgAccess: 'all',
        orgIds: [],
      }),
    ).toBe('scope.eq.global');
  });

  it('drops a MID-TOKEN wildcard rather than widening the key', () => {
    // `SCOPE_PATTERN` in `schemas/api-key.ts` is the authority and allows `*`
    // only directly after `/` or `::`. A stored `repo::mthines/lore*` is
    // therefore malformed, and admitting it would become the LIKE prefix
    // `repo::mthines/lore%` — reaching every repo starting with those letters.
    // Dropping is the only direction this filter may move.
    expect(
      keyScopeFilter({
        scopes: ['repo::mthines/lore*', 'project::alpha'],
        orgAccess: 'all',
        orgIds: [],
      }),
    ).toBe('scope.eq.project::alpha');
    // The two legal wildcard positions still work.
    expect(
      keyScopeFilter({ scopes: ['repo::mthines/*'], orgAccess: 'all', orgIds: [] }),
    ).toBe('scope.like.repo::mthines/%');
    expect(
      keyScopeFilter({ scopes: ['project::*'], orgAccess: 'all', orgIds: [] }),
    ).toBe('scope.like.project::%');
  });

  it('matches NOTHING when every pattern was malformed', () => {
    // The key IS restricted, so an impossible predicate is the only honest
    // answer — falling back to "no filter" would widen a restricted key.
    expect(
      keyScopeFilter({ scopes: ['a,b', ')('], orgAccess: 'all', orgIds: [] }),
    ).toBe('scope.is.null');
  });
});

describe('applyTenantScope with a key restriction', () => {
  it('is byte-for-byte the old behaviour for an unrestricted key', () => {
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a'], { scopes: [], orgAccess: 'all', orgIds: [] });
    expect(query.or).toHaveBeenCalledTimes(1);
    expect(query.or).toHaveBeenCalledWith('user_id.eq.user-1,org_id.in.("org-a")');
  });

  it('collapses to personal-only under "personal", even with member orgs', () => {
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a'], { scopes: [], orgAccess: 'personal', orgIds: [] });
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    // ...and the owner's OWN org-owned rows are excluded too. `personal` is a
    // tenancy, not an ownership test: `lorekit_api_token_org_allowed` answers
    // false for every non-null org_id under it, so a filter that stopped at
    // `user_id` would hand back rows the SQL side denies.
    expect(query.or).toHaveBeenCalledWith('org_id.is.null');
  });

  it('under "selected", the personal disjunct excludes non-selected org rows', () => {
    // The owner's own rows in an org the key was NOT pointed at must not come
    // back: `and(...)` binds the ownership test to `org_id.is.null` so the
    // only org rows that match are the ones named in the `in.()` list.
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a', 'org-b'], {
      scopes: [],
      orgAccess: 'selected',
      orgIds: ['org-a'],
    });
    expect(query.or).toHaveBeenCalledWith(
      'and(user_id.eq.user-1,org_id.is.null),org_id.in.("org-a")',
    );
  });

  it('under "selected" with no reachable org, still excludes the owner\'s org rows', () => {
    // The intersection can be empty (the key names an org its owner has since
    // left). That collapses to the personal branch, which must carry the same
    // exclusion rather than falling back to a bare ownership filter.
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a'], {
      scopes: [],
      orgAccess: 'selected',
      orgIds: ['org-z'],
    });
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.or).toHaveBeenCalledWith('org_id.is.null');
  });

  it('an unrestricted key never gets the org_id.is.null exclusion', () => {
    // The one direction this must not move: `all` (and no key at all) keeps
    // the pre-00068 fragment exactly, org rows included.
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', [], { scopes: [], orgAccess: 'all', orgIds: [] });
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.or).not.toHaveBeenCalled();
  });

  it('ANDs the scope allowlist as a SECOND .or() call', () => {
    // PostgREST ANDs top-level filters, so two .or() calls read as
    // "(mine or my orgs') AND (in the allowlist)". One combined call would OR
    // them together and widen the read instead of narrowing it.
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', ['org-a'], {
      scopes: ['repo::mthines/*'],
      orgAccess: 'all',
      orgIds: [],
    });
    expect(query.or.mock.calls.map((c) => c[0])).toEqual([
      'user_id.eq.user-1,org_id.in.("org-a")',
      'scope.like.repo::mthines/%',
    ]);
  });

  it('applies the allowlist to a personal-only read too', () => {
    // The case a per-call-site check misses: no scope named, no orgs, and the
    // key still must not see rows outside its allowlist.
    const query = fakeQuery();
    applyTenantScope(query, 'user-1', [], {
      scopes: ['global'],
      orgAccess: 'personal',
      orgIds: [],
    });
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.or).toHaveBeenCalledWith('scope.eq.global');
  });
});

describe('ownRowsFragment', () => {
  it('is the bare ownership test with no key, and under "all"', () => {
    expect(ownRowsFragment('user-1')).toBe('user_id.eq.user-1');
    expect(ownRowsFragment('user-1', { scopes: [], orgAccess: 'all', orgIds: [] }))
      .toBe('user_id.eq.user-1');
  });

  it('binds ownership to org_id.is.null under "personal" and "selected"', () => {
    expect(ownRowsFragment('user-1', { scopes: [], orgAccess: 'personal', orgIds: [] }))
      .toBe('and(user_id.eq.user-1,org_id.is.null)');
    expect(ownRowsFragment('user-1', { scopes: [], orgAccess: 'selected', orgIds: ['org-a'] }))
      .toBe('and(user_id.eq.user-1,org_id.is.null)');
  });
});

describe('restrictsTenancy', () => {
  it('is false exactly where the pre-00068 behaviour must be preserved', () => {
    expect(restrictsTenancy()).toBe(false);
    expect(restrictsTenancy({ scopes: [], orgAccess: 'all', orgIds: [] })).toBe(false);
    expect(restrictsTenancy({ scopes: ['global'], orgAccess: 'all', orgIds: [] })).toBe(false);
  });

  it('is true for both narrowing tenancies', () => {
    expect(restrictsTenancy({ scopes: [], orgAccess: 'personal', orgIds: [] })).toBe(true);
    expect(restrictsTenancy({ scopes: [], orgAccess: 'selected', orgIds: [] })).toBe(true);
  });
});

/**
 * Parity guard: every copy of `SCOPE_PATTERN` in the repo says the same thing.
 *
 * `tenant-scope.ts` is deliberately import-free — it is mirrored verbatim into
 * the Deno edge tree, which cannot cross-import this package — so it RESTATES
 * `SCOPE_PATTERN` rather than importing it. That is the right trade for the
 * mirror, but it means the shape test now lives in five places: the schema
 * (the authority), this module, and three SQL copies. Nothing structurally
 * stops one from being tightened while the others stay loose, and a LOOSER copy
 * silently WIDENS a scoped key — the one direction these predicates must never
 * move.
 *
 * This is that pin. It compares the pattern SOURCE, not behaviour on a sample,
 * because a sample can agree by accident on every string anybody thought to
 * write down.
 */
describe('SCOPE_PATTERN parity across every copy', () => {
  const repoRoot = path.resolve(here, '../../../..');
  const read = (rel: string) => readFileSync(path.resolve(repoRoot, rel), 'utf8');

  // The authority, as written in `packages/schemas/src/domain/api-key.ts`.
  const AUTHORITY = String.raw`^[a-z0-9._:/-]+(?:(?:\/|::)\*)?$`;
  // The same shape in POSIX regex, as the SQL copies must spell it: Postgres
  // `~` has no non-capturing-group syntax and needs no `/` escape.
  const AUTHORITY_SQL = String.raw`^[a-z0-9._:/-]+((/|::)\*)?$`;

  it('the schema still says what this guard thinks it says (anti-vacuity)', () => {
    expect(read('packages/schemas/src/domain/api-key.ts')).toContain(`/${AUTHORITY}/`);
  });

  it.each([
    ['packages/mcp-core/src/auth/tenant-scope.ts', AUTHORITY],
    ['supabase/functions/_shared/auth/tenant-scope.ts', AUTHORITY],
  ])('%s restates the authority verbatim', (file, expected) => {
    expect(read(file)).toContain(expected);
  });

  it.each([
    ['supabase/migrations/00069_api_token_scoping_enforcement.sql', AUTHORITY_SQL],
    ['supabase/byod/bootstrap.sql', AUTHORITY_SQL],
  ])('%s carries the POSIX spelling of the same shape', (file, expected) => {
    expect(read(file)).toContain(expected);
  });

  it('no copy admits a MID-TOKEN wildcard, which is the widening this pins', () => {
    // The concrete regression: `repo::mthines/lore*` must not be a pattern in
    // any copy. Asserted through the one exported consumer as well as the
    // source comparison above, so the pin fails on behaviour too.
    expect(keyScopeFilter({ scopes: ['repo::mthines/lore*'], orgAccess: 'all', orgIds: [] }))
      .toBe('scope.is.null');
  });
});
