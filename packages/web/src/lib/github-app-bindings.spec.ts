import { describe, it, expect } from 'vitest';
import {
  repoScope,
  partitionRepos,
  manageableOrgs,
  bindingSuggestion,
  type BindingsByScope,
} from './github-app-bindings';
import type { OrgMembership } from './orgs';

function org(slug: string, role: OrgMembership['role']): OrgMembership {
  return { id: `id-${slug}`, slug, name: slug, created_at: '2026-01-01T00:00:00Z', role };
}

describe('repoScope', () => {
  it('builds the canonical repo scope, lowercased and trimmed', () => {
    expect(repoScope('Mthines/GSAP')).toBe('repo::mthines/gsap');
    expect(repoScope('  acme/api  ')).toBe('repo::acme/api');
  });
});

describe('partitionRepos', () => {
  const bindings: BindingsByScope = {
    'repo::acme/api': { orgId: 'o1', orgSlug: 'acme' },
  };

  it('splits repos into bound (with org) and unbound, preserving order', () => {
    const state = partitionRepos(
      [{ full_name: 'acme/web' }, { full_name: 'acme/api' }, { full_name: 'acme/cli' }],
      bindings,
    );
    expect(state.unbound.map((r) => r.fullName)).toEqual(['acme/web', 'acme/cli']);
    expect(state.bound).toEqual([
      { fullName: 'acme/api', scope: 'repo::acme/api', orgId: 'o1', orgSlug: 'acme' },
    ]);
  });

  it('matches case-insensitively via the canonical scope', () => {
    const state = partitionRepos([{ full_name: 'ACME/API' }], bindings);
    expect(state.bound).toHaveLength(1);
    expect(state.unbound).toHaveLength(0);
  });

  it('returns empty groups for no repos', () => {
    expect(partitionRepos([], bindings)).toEqual({ bound: [], unbound: [] });
  });
});

describe('manageableOrgs', () => {
  it('keeps only admin/owner orgs (manage_scopes)', () => {
    const orgs = [org('a', 'owner'), org('b', 'admin'), org('c', 'member'), org('d', 'viewer')];
    expect(manageableOrgs(orgs).map((o) => o.slug)).toEqual(['a', 'b']);
  });
});

describe('bindingSuggestion', () => {
  const unboundState = { bound: [], unbound: [{ fullName: 'acme/web', scope: 'repo::acme/web' }] };

  it('returns null when nothing is unbound', () => {
    expect(bindingSuggestion({ github_account_login: 'acme' }, [org('acme', 'owner')], { bound: [], unbound: [] })).toBeNull();
  });

  it('returns null when the caller manages no org', () => {
    expect(bindingSuggestion({ github_account_login: 'acme' }, [], unboundState)).toBeNull();
  });

  it('prefers an org whose slug matches the GitHub account login', () => {
    const s = bindingSuggestion(
      { github_account_login: 'Acme' },
      [org('other', 'owner'), org('acme', 'admin')],
      unboundState,
    );
    expect(s).toMatchObject({ reason: 'name-match', org: { slug: 'acme' }, repos: ['acme/web'] });
  });

  it('falls back to the single manageable org when no name matches', () => {
    const s = bindingSuggestion({ github_account_login: 'mthines' }, [org('solo', 'owner')], unboundState);
    expect(s).toMatchObject({ reason: 'only-org', org: { slug: 'solo' } });
  });

  it('suggests nothing when several orgs match none by name', () => {
    const s = bindingSuggestion(
      { github_account_login: 'mthines' },
      [org('one', 'owner'), org('two', 'admin')],
      unboundState,
    );
    expect(s).toBeNull();
  });
});
