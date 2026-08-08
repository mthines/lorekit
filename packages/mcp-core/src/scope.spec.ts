import { describe, it, expect } from 'vitest';
import { validateScope, safeValidateScope, scopeType, expandScopeForSearch, ScopeValidationError } from './scope.js';

describe('validateScope', () => {
  it('accepts "global"', () => {
    expect(validateScope('global')).toBe('global');
  });

  it('accepts valid project scope', () => {
    expect(validateScope('project::agent-skills')).toBe('project::agent-skills');
  });

  it('accepts valid repo scope', () => {
    expect(validateScope('repo::mthines/gw-tools')).toBe('repo::mthines/gw-tools');
  });

  it('accepts valid branch scope', () => {
    expect(validateScope('branch::mthines/gw-tools::feat/add-memory')).toBe(
      'branch::mthines/gw-tools::feat/add-memory',
    );
  });

  it('normalises to lowercase', () => {
    expect(validateScope('REPO::Mthines/GW-Tools')).toBe('repo::mthines/gw-tools');
  });

  it('throws on single-colon separator', () => {
    expect(() => validateScope('repo:mthines/gw-tools')).toThrow(ScopeValidationError);
    expect(() => validateScope('repo:mthines/gw-tools')).toThrow('use "::" as the separator');
  });

  it('throws on unknown prefix', () => {
    expect(() => validateScope('workspace::foo')).toThrow(ScopeValidationError);
  });

  it('throws on empty value after prefix', () => {
    expect(() => validateScope('repo::')).toThrow(ScopeValidationError);
  });

  it('throws on repo scope without slash', () => {
    expect(() => validateScope('repo::mthines')).toThrow(ScopeValidationError);
  });

  it('throws on branch scope without second ::', () => {
    expect(() => validateScope('branch::mthines/gw-tools')).toThrow(ScopeValidationError);
  });

  it('accepts a branch name containing a slash', () => {
    expect(validateScope('branch::mthines/gw-tools::feat/x')).toBe('branch::mthines/gw-tools::feat/x');
  });

  // SECURITY: a validated scope is interpolated into the search tool's
  // `scope.in.("<scope>")` PostgREST filter, so a branch name must not admit `"`
  // or `,` (they would break out of the quoted value). See validateScope.
  it('rejects a branch name carrying PostgREST filter metacharacters', () => {
    for (const evil of [
      'branch::o/r::a",value.not.is.null',
      'branch::o/r::a,scope.like.z',
      'branch::o/r::a)',
    ]) {
      expect(() => validateScope(evil)).toThrow(ScopeValidationError);
    }
  });
});

describe('scopeType', () => {
  it('returns "global" for global', () => expect(scopeType('global')).toBe('global'));
  it('returns "project" for project scope', () => expect(scopeType('project::foo')).toBe('project'));
  it('returns "repo" for repo scope', () => expect(scopeType('repo::mthines/x')).toBe('repo'));
  it('returns "branch" for branch scope', () => expect(scopeType('branch::mthines/x::feat')).toBe('branch'));
});

describe('expandScopeForSearch', () => {
  it('returns exact for a normal scope', () => {
    const result = expandScopeForSearch('repo::mthines/gw-tools');
    expect(result).toEqual({ exact: 'repo::mthines/gw-tools' });
  });

  it('returns like pattern for owner wildcard', () => {
    const result = expandScopeForSearch('repo::mthines/*');
    expect('like' in result).toBe(true);
    if ('like' in result) {
      expect(result.like).toMatch(/^repo::mthines\//);
      expect(result.like).toMatch(/%$/);
    }
  });

  it('returns like pattern for a project wildcard', () => {
    const result = expandScopeForSearch('project::*');
    expect(result).toEqual({ like: 'project::%' });
  });

  // SECURITY: a wildcard scope is interpolated into a PostgREST `.or()` filter,
  // so PostgREST-structural characters must be rejected to prevent filter
  // injection (extra OR predicates) — see expandScopeForSearch.
  it('rejects a wildcard scope carrying PostgREST filter metacharacters', () => {
    for (const evil of [
      'a,value.not.is.null,scope.like.z::*',
      'repo::mthines),(value.ilike.*x*/*',
      'repo::"owner"/*',
      'project::a b::*',
    ]) {
      expect(() => expandScopeForSearch(evil)).toThrow(ScopeValidationError);
    }
  });
});

// `usage_events.scope` (migration 00058) is a telemetry dimension recorded
// alongside the operation it measures, so its validator must be TOTAL: the one
// thing it may never do is throw, because throwing would fail the very call it
// exists to describe. It is a thin wrapper over `validateScope`, not a second
// grammar — these cases pin the wrapper's contract, not the grammar's.
describe('safeValidateScope', () => {
  it('normalises a valid scope exactly as validateScope does', () => {
    expect(safeValidateScope('Repo::mthines/LoreKit')).toBe('repo::mthines/lorekit');
    expect(safeValidateScope('GLOBAL')).toBe('global');
    expect(safeValidateScope('branch::mthines/x::Feat/A')).toBe('branch::mthines/x::feat/a');
  });

  // The delegation is the point: anything validateScope accepts, this returns
  // IDENTICALLY, and anything it rejects becomes null. Asserting agreement
  // rather than a hardcoded list is what stops the two drifting apart.
  it('agrees with validateScope on every accepted input', () => {
    for (const raw of ['global', 'project::my.app', 'repo::mthines/lorekit', 'branch::a/b::main']) {
      expect(safeValidateScope(raw)).toBe(validateScope(raw));
    }
  });

  it('returns null for an ungrammatical scope instead of throwing', () => {
    for (const bad of ['bogus:x', 'repo:mthines/x', 'repo::', 'repo::no-slash', 'nope::x', 'project::a b']) {
      expect(() => validateScope(bad)).toThrow(ScopeValidationError);
      expect(safeValidateScope(bad)).toBeNull();
    }
  });

  it('returns null for absent / empty / non-string input', () => {
    expect(safeValidateScope('')).toBeNull();
    expect(safeValidateScope(null)).toBeNull();
    expect(safeValidateScope(undefined)).toBeNull();
    expect(safeValidateScope(42)).toBeNull();
    expect(safeValidateScope({})).toBeNull();
    expect(safeValidateScope(['repo::a/b'])).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      '', ' ', '::', ':::', 'repo::"a",value.not.is.null', '\u0000', 'x'.repeat(5000),
      null, undefined, 0, NaN, true, [], {}, Symbol('s'),
      // A property that throws when read would break a naive implementation
      // that touched anything other than the value itself.
      { get length() { throw new Error('boom'); } },
    ];
    for (const input of hostile) {
      expect(() => safeValidateScope(input)).not.toThrow();
    }
  });
});
