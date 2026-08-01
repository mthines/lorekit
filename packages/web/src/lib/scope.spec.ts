import { describe, it, expect } from 'vitest';
import { scopeType, scopeRepoUrl, scopeRepoRef } from './scope';

describe('scopeType', () => {
  it('returns "global" for the literal string "global"', () => {
    expect(scopeType('global')).toBe('global');
  });

  it('returns "project" for project-scoped keys', () => {
    expect(scopeType('project::agent-skills')).toBe('project');
    expect(scopeType('project::lorekit')).toBe('project');
  });

  it('returns "repo" for repo-scoped keys', () => {
    expect(scopeType('repo::mthines/gw-tools')).toBe('repo');
    expect(scopeType('repo::org/name')).toBe('repo');
  });

  it('returns "branch" for branch-scoped keys', () => {
    expect(scopeType('branch::mthines/gw-tools::feat/x')).toBe('branch');
  });

  it('handles upper-case prefixes the same way (pass-through)', () => {
    // The function does a simple split — upper-case is not normalised here;
    // that responsibility lives in mcp-core. Test documents current behaviour.
    expect(scopeType('project::MyProject')).toBe('project');
  });
});

describe('scopeRepoUrl', () => {
  it('builds a GitHub repo URL for repo scopes', () => {
    expect(scopeRepoUrl('repo::mthines/lorekit')).toBe(
      'https://github.com/mthines/lorekit',
    );
    expect(scopeRepoUrl('repo::mthines/gw-tools')).toBe(
      'https://github.com/mthines/gw-tools',
    );
  });

  it('builds a GitHub branch (tree) URL for branch scopes', () => {
    expect(scopeRepoUrl('branch::mthines/gw-tools::feat/x')).toBe(
      'https://github.com/mthines/gw-tools/tree/feat/x',
    );
    expect(scopeRepoUrl('branch::mthines/lorekit::main')).toBe(
      'https://github.com/mthines/lorekit/tree/main',
    );
  });

  it('returns null for scopes with no repository to point at', () => {
    expect(scopeRepoUrl('global')).toBeNull();
    expect(scopeRepoUrl('project::lorekit')).toBeNull();
  });

  it('returns null for malformed repo/branch scopes', () => {
    expect(scopeRepoUrl('repo::not-a-repo')).toBeNull(); // missing owner/name split
    expect(scopeRepoUrl('branch::owner/repo')).toBeNull(); // missing branch segment
    expect(scopeRepoUrl('branch::not-a-repo::main')).toBeNull(); // bad owner/name
  });
});

describe('scopeRepoRef', () => {
  it('extracts the repo a repo:: scope names', () => {
    expect(scopeRepoRef('repo::mthines/lorekit')).toEqual({ repo: 'mthines/lorekit', branch: null });
  });

  it('extracts both halves of a branch:: scope', () => {
    expect(scopeRepoRef('branch::mthines/lorekit::feat/x')).toEqual({
      repo: 'mthines/lorekit',
      branch: 'feat/x',
    });
  });

  it('names no repo for global / project / malformed scopes', () => {
    const none = { repo: null, branch: null };
    expect(scopeRepoRef('global')).toEqual(none);
    expect(scopeRepoRef('project::lorekit')).toEqual(none);
    expect(scopeRepoRef('repo::not-a-repo')).toEqual(none);
    expect(scopeRepoRef('branch::owner/repo')).toEqual(none);
  });

  it('agrees with scopeRepoUrl — one derivation, two consumers', () => {
    for (const scope of ['global', 'project::x', 'repo::a/b', 'branch::a/b::feat/x', 'repo::bad']) {
      expect(scopeRepoRef(scope).repo === null).toBe(scopeRepoUrl(scope) === null);
    }
  });
});
