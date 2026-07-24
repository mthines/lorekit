import { describe, it, expect } from 'vitest';
import { scopeType } from './scope';

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
