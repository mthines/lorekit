import { describe, it, expect } from 'vitest';
import { parseScopeKeyQuery } from './scope-key-query';

describe('parseScopeKeyQuery', () => {
  it('splits a full repo-scoped scope::key identifier', () => {
    expect(
      parseScopeKeyQuery(
        'repo::mthines/lorekit::sandbox-lessons::lorekit-mcp-url-does-not-override-a-config-file-endpoint',
      ),
    ).toEqual({
      scope: 'repo::mthines/lorekit',
      keyPrefix: 'sandbox-lessons::lorekit-mcp-url-does-not-override-a-config-file-endpoint',
    });
  });

  it('splits a truncated key as a prefix, unchanged', () => {
    expect(parseScopeKeyQuery('repo::mthines/lorekit::sandbox-lessons::lorekit-mcp-')).toEqual({
      scope: 'repo::mthines/lorekit',
      keyPrefix: 'sandbox-lessons::lorekit-mcp-',
    });
  });

  it('returns an empty key prefix for a bare scope (search any key in it)', () => {
    expect(parseScopeKeyQuery('repo::mthines/lorekit')).toEqual({
      scope: 'repo::mthines/lorekit',
      keyPrefix: '',
    });
  });

  it('returns an empty key prefix for a scope with a trailing separator', () => {
    expect(parseScopeKeyQuery('repo::mthines/lorekit::')).toEqual({
      scope: 'repo::mthines/lorekit',
      keyPrefix: '',
    });
  });

  it('handles the single-segment "global" scope', () => {
    expect(parseScopeKeyQuery('global::some-key')).toEqual({
      scope: 'global',
      keyPrefix: 'some-key',
    });
  });

  it('handles a project scope', () => {
    expect(parseScopeKeyQuery('project::agent-skills::aw-lessons::foo')).toEqual({
      scope: 'project::agent-skills',
      keyPrefix: 'aw-lessons::foo',
    });
  });

  it('handles a branch scope (3 fixed segments)', () => {
    expect(parseScopeKeyQuery('branch::mthines/lorekit::feat/x::aw-lessons::foo')).toEqual({
      scope: 'branch::mthines/lorekit::feat/x',
      keyPrefix: 'aw-lessons::foo',
    });
  });

  it('returns null while a branch scope is still incomplete', () => {
    // "branch::{owner}/{repo}::{branch}" needs 3 segments; only 2 typed so far.
    expect(parseScopeKeyQuery('branch::mthines/lorekit')).toBeNull();
  });

  it('treats a 2-segment repo scope as complete even without a slash', () => {
    // The parser counts `::`-segments only; it does not additionally validate
    // the `owner/repo` shape of the second segment. A malformed scope like
    // this one is still forwarded to the server, which returns no matches
    // for it — a harmless imprecision, not a correctness gap `key_prefix`
    // narrowing depends on.
    expect(parseScopeKeyQuery('repo::mthines')).toEqual({ scope: 'repo::mthines', keyPrefix: '' });
  });

  it('returns null for an unrecognized prefix', () => {
    expect(parseScopeKeyQuery('not-a-scope::foo')).toBeNull();
    expect(parseScopeKeyQuery('lorekit-mcp-url-does-not-override')).toBeNull();
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(parseScopeKeyQuery('')).toBeNull();
    expect(parseScopeKeyQuery('   ')).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseScopeKeyQuery('  repo::mthines/lorekit::foo  ')).toEqual({
      scope: 'repo::mthines/lorekit',
      keyPrefix: 'foo',
    });
  });

  it('is case-insensitive on the prefix only, preserving the rest verbatim', () => {
    expect(parseScopeKeyQuery('REPO::Mthines/Lorekit::Foo')).toEqual({
      scope: 'REPO::Mthines/Lorekit',
      keyPrefix: 'Foo',
    });
  });
});
