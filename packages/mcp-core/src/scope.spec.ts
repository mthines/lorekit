import { describe, it, expect } from 'vitest';
import { validateScope, scopeType, expandScopeForSearch, ScopeValidationError } from './scope.js';

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
});
