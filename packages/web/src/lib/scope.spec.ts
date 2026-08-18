import { describe, it, expect } from 'vitest';
import {
  scopeType,
  scopeRepoUrl,
  scopeRepoRef,
  isCanonicalScope,
  resolveScopeParam,
} from './scope';

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

describe('scopeRepoUrl — relative path segments', () => {
  it('refuses a scope whose repo contains a parent-directory segment', () => {
    // `..` matches `[\w.-]+`, so `repo::../evil` is a well-formed scope — and
    // https://github.com/../evil resolves in the browser to github.com/evil.
    expect(scopeRepoUrl('repo::../evil')).toBeNull();
    expect(scopeRepoUrl('repo::./evil')).toBeNull();
    expect(scopeRepoUrl('repo::owner/..')).toBeNull();
  });

  it('refuses a branch scope whose branch contains a .. segment', () => {
    expect(scopeRepoUrl('branch::owner/repo::feat/../../x')).toBeNull();
  });

  it('still resolves a legitimate repo and branch scope', () => {
    expect(scopeRepoUrl('repo::mthines/lorekit')).toBe('https://github.com/mthines/lorekit');
    expect(scopeRepoUrl('branch::mthines/lorekit::feat/x')).toBe(
      'https://github.com/mthines/lorekit/tree/feat/x',
    );
  });
});

describe('isCanonicalScope', () => {
  it('accepts every scope shape the API serves', () => {
    expect(isCanonicalScope('global')).toBe(true);
    expect(isCanonicalScope('project::daily-report-lorekit-web')).toBe(true);
    expect(isCanonicalScope('repo::mthines/lorekit')).toBe(true);
    expect(isCanonicalScope('branch::mthines/lorekit::feat/x')).toBe(true);
  });

  it('accepts a `global::…` scope, which the edge validator also accepts', () => {
    // The stricter mcp-core grammar has no rule for it either, and real
    // accounts hold rows under it. Rejecting it here would hide live data
    // behind a filter the chip strip still offers.
    expect(isCanonicalScope('global::daily-report-lorekit-web')).toBe(true);
  });

  it('REJECTS a bare scope TYPE — the value that 400d /read-activity', () => {
    // `?scope="repo"` reached GET /memories/read-activity as `scope=repo` and
    // came back 400 while /activity, /facets and GET /memories returned 200
    // with nothing. One param, two failure modes, one broken card.
    expect(isCanonicalScope('repo')).toBe(false);
    expect(isCanonicalScope('project')).toBe(false);
    expect(isCanonicalScope('branch')).toBe(false);
  });

  it('rejects the single-colon separator mistake', () => {
    expect(isCanonicalScope('repo:mthines/lorekit')).toBe(false);
    expect(isCanonicalScope('project:lorekit')).toBe(false);
  });

  it('rejects an unknown prefix', () => {
    expect(isCanonicalScope('team::acme')).toBe(false);
    expect(isCanonicalScope('::nothing')).toBe(false);
  });

  it('rejects characters that are structural in the PostgREST filter', () => {
    expect(isCanonicalScope('project::a",value.not.is.null')).toBe(false);
    expect(isCanonicalScope('repo::a,b')).toBe(false);
    expect(isCanonicalScope('repo::a(b)')).toBe(false);
  });

  it('accepts a mixed-case value, which the edge filters on exactly', () => {
    // `parseScopeFilter` is reject-only, so the caller's own string is what
    // reaches the predicate — and the REST write path stores `scope` verbatim,
    // so mixed-case rows exist. Refusing the filter would hide them.
    expect(isCanonicalScope('Repo::Mthines/LoreKit')).toBe(true);
    expect(isCanonicalScope('GLOBAL')).toBe(true);
  });

  it('rejects a padded value, which could only ever match nothing', () => {
    // The grammar check trims before it looks; the predicate does not. The edge
    // filter rejects the padded form outright, so this mirrors it.
    expect(isCanonicalScope(' global')).toBe(false);
    expect(isCanonicalScope('repo::mthines/lorekit ')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isCanonicalScope('')).toBe(false);
  });
});

describe('resolveScopeParam', () => {
  it('passes a canonical scope through as the filter', () => {
    expect(resolveScopeParam('repo::mthines/lorekit')).toEqual({
      scope: 'repo::mthines/lorekit',
      rejected: null,
    });
  });

  it('treats an absent param as "all scopes", with nothing rejected', () => {
    expect(resolveScopeParam(null)).toEqual({ scope: null, rejected: null });
    expect(resolveScopeParam('')).toEqual({ scope: null, rejected: null });
  });

  it('drops an ungrammatical scope AND reports it, never silently', () => {
    // Reporting it is the point: widening to all scopes without saying so
    // answers a wider question than the link asked for.
    expect(resolveScopeParam('repo')).toEqual({ scope: null, rejected: 'repo' });
  });

  it('never returns both a filter and a rejection', () => {
    for (const raw of [null, '', 'global', 'repo', 'repo::a/b', 'nonsense', 'repo:a/b']) {
      const { scope, rejected } = resolveScopeParam(raw);
      expect(scope === null || rejected === null).toBe(true);
    }
  });
});

describe('mixed-case scopes (accepted since the reject-only filter change)', () => {
  it('types a mixed-case scope by its lowercased prefix', () => {
    // Reading the raw prefix would return `Repo`, which is not a ScopePrefix
    // and silently loses the repo link derived from it.
    expect(scopeType('Repo::Owner/Name')).toBe('repo');
    expect(scopeType('BRANCH::Owner/Name::Feat/X')).toBe('branch');
    expect(scopeType('GLOBAL')).toBe('global');
  });

  it('still derives the repo reference from a mixed-case scope', () => {
    expect(scopeRepoRef('Repo::Owner/Name')).toEqual({ repo: 'Owner/Name', branch: null });
    expect(scopeRepoRef('Branch::Owner/Name::Feat/X')).toEqual({
      repo: 'Owner/Name',
      branch: 'Feat/X',
    });
  });
});
