import { describe, it, expect } from 'vitest';
import {
  resolvePolicyConditions,
  resolveGroomConditions,
  scopeMatchesPolicy,
  matchText,
  matchTags,
  isGroomCandidate,
  groomCandidates,
  type RetentionPolicyRow,
  type GroomCandidateMemory,
  type GroomConditions,
} from './groom.js';

const NOW = new Date('2026-08-26T00:00:00.000Z');

function memory(overrides: Partial<GroomCandidateMemory> = {}): GroomCandidateMemory {
  return {
    id: 'm1',
    scope: 'global',
    key: 'k1',
    created_at: '2026-01-01T00:00:00.000Z',
    last_opened_at: null,
    seen_count: 1,
    protected: false,
    tags: null,
    source_agent: null,
    trigger: null,
    kind: null,
    host: null,
    origin_repo: null,
    origin_branch: null,
    origin_pr: null,
    ...overrides,
  };
}

/** A full `GroomConditions`, every field defaulted to "not filtered" (`null`). */
function conditions(overrides: Partial<GroomConditions> & { scope: string }): GroomConditions {
  return {
    min_age_days: null,
    unseen_days: null,
    max_seen_count: null,
    tags: null,
    tags_mode: null,
    source_agent: null,
    source_agent_mode: null,
    trigger: null,
    trigger_mode: null,
    kind: null,
    kind_mode: null,
    host: null,
    host_mode: null,
    origin_repo: null,
    origin_repo_mode: null,
    origin_branch: null,
    origin_branch_mode: null,
    origin_pr: null,
    origin_pr_mode: null,
    ...overrides,
  };
}

const basePolicy: RetentionPolicyRow = {
  id: 'p1',
  scope: 'global',
  mode: 'review',
  enabled: false,
  min_age_days: null,
  unseen_days: null,
  max_seen_count: null,
  tags: null,
  tags_mode: null,
  source_agent: null,
  source_agent_mode: null,
  trigger: null,
  trigger_mode: null,
  kind: null,
  kind_mode: null,
  host: null,
  host_mode: null,
  origin_repo: null,
  origin_repo_mode: null,
  origin_branch: null,
  origin_branch_mode: null,
  origin_pr: null,
  origin_pr_mode: null,
};

describe('resolvePolicyConditions', () => {
  it('projects a policy row onto the conditions struct', () => {
    const policy: RetentionPolicyRow = { ...basePolicy, scope: 'repo::acme/app', min_age_days: 30, unseen_days: 14, max_seen_count: 2 };
    expect(resolvePolicyConditions(policy)).toEqual(
      conditions({ scope: 'repo::acme/app', min_age_days: 30, unseen_days: 14, max_seen_count: 2 }),
    );
  });

  it('projects a policy row\'s dimension filters too', () => {
    const policy: RetentionPolicyRow = {
      ...basePolicy,
      scope: 'repo::acme/app',
      tags: ['perf'],
      tags_mode: 'all',
      host: ['reviewer'],
      host_mode: 'nin',
    };
    expect(resolvePolicyConditions(policy)).toEqual(
      conditions({ scope: 'repo::acme/app', tags: ['perf'], tags_mode: 'all', host: ['reviewer'], host_mode: 'nin' }),
    );
  });
});

describe('resolveGroomConditions', () => {
  it('resolves a policy_id request using the fetched row', () => {
    const policy: RetentionPolicyRow = { ...basePolicy, scope: 'global', min_age_days: 7 };
    const result = resolveGroomConditions({ policy_id: 'p1' }, policy);
    expect(result).toEqual(conditions({ scope: 'global', min_age_days: 7 }));
  });

  it('throws when a policy_id request has no matching row', () => {
    expect(() => resolveGroomConditions({ policy_id: 'missing' }, null)).toThrow(/no policy found/);
  });

  it('resolves an inline request without a policy row', () => {
    const result = resolveGroomConditions({ scope: 'project::x', min_age_days: 10 }, null);
    expect(result).toEqual(conditions({ scope: 'project::x', min_age_days: 10 }));
  });

  it('defaults omitted inline conditions to null, not undefined', () => {
    const result = resolveGroomConditions({ scope: 'global' }, null);
    expect(result).toEqual(conditions({ scope: 'global' }));
  });

  it('resolves an inline request\'s dimension filters, defaulting an omitted one to null', () => {
    const result = resolveGroomConditions(
      { scope: 'global', kind: ['lesson'], kind_mode: 'in', origin_pr: ['482'] },
      null,
    );
    expect(result).toEqual(
      conditions({ scope: 'global', kind: ['lesson'], kind_mode: 'in', origin_pr: ['482'] }),
    );
  });
});

describe('scopeMatchesPolicy — the ::-delimited hierarchy', () => {
  it('global reaches every scope', () => {
    expect(scopeMatchesPolicy('project::x', 'global')).toBe(true);
    expect(scopeMatchesPolicy('repo::acme/app', 'global')).toBe(true);
    expect(scopeMatchesPolicy('branch::acme/app::main', 'global')).toBe(true);
  });

  it('an exact scope match always reaches', () => {
    expect(scopeMatchesPolicy('repo::acme/app', 'repo::acme/app')).toBe(true);
    expect(scopeMatchesPolicy('project::x', 'project::x')).toBe(true);
  });

  it('a repo policy reaches every branch scope nested under it', () => {
    expect(scopeMatchesPolicy('branch::acme/app::main', 'repo::acme/app')).toBe(true);
    expect(scopeMatchesPolicy('branch::acme/app::feat/x', 'repo::acme/app')).toBe(true);
  });

  it('a repo policy does NOT reach a different repo, even with a shared prefix', () => {
    expect(scopeMatchesPolicy('branch::acme/app-2::main', 'repo::acme/app')).toBe(false);
    expect(scopeMatchesPolicy('repo::acme/app-2', 'repo::acme/app')).toBe(false);
  });

  it('a project or branch policy reaches only its exact scope — nothing nests under them', () => {
    expect(scopeMatchesPolicy('branch::acme/app::main', 'project::x')).toBe(false);
    expect(scopeMatchesPolicy('repo::acme/app', 'branch::acme/app::main')).toBe(false);
  });
});

describe('matchText', () => {
  it('a null filter is "not filtered" — matches everything', () => {
    expect(matchText('reviewer', null, 'in')).toBe(true);
    expect(matchText(null, null, 'in')).toBe(true);
  });

  it('"in" (default) matches a value in the list', () => {
    expect(matchText('reviewer', ['reviewer', 'aw'], null)).toBe(true);
    expect(matchText('ci-auto-fix', ['reviewer', 'aw'], 'in')).toBe(false);
  });

  it('"nin" excludes a value in the list and admits every other value', () => {
    expect(matchText('reviewer', ['reviewer'], 'nin')).toBe(false);
    expect(matchText('aw', ['reviewer'], 'nin')).toBe(true);
  });

  it('"nin" excludes a NULL value rather than admitting it via a false NULL comparison', () => {
    // The subtlety `lorekit_match_text`'s docblock calls out: an unattributed
    // row must not slip through "is not one of these".
    expect(matchText(null, ['reviewer'], 'nin')).toBe(false);
  });

  it('"in" never matches a NULL value', () => {
    expect(matchText(null, ['reviewer'], 'in')).toBe(false);
  });
});

describe('matchTags', () => {
  it('a null filter is "not filtered" — matches everything', () => {
    expect(matchTags(['perf'], null, 'any')).toBe(true);
    expect(matchTags(null, null, 'any')).toBe(true);
  });

  it('"any" (default) matches on overlap', () => {
    expect(matchTags(['perf', 'ci'], ['perf'], null)).toBe(true);
    expect(matchTags(['ci'], ['perf'], 'any')).toBe(false);
  });

  it('"all" requires every filter value to be carried', () => {
    expect(matchTags(['perf', 'ci', 'flaky'], ['perf', 'ci'], 'all')).toBe(true);
    expect(matchTags(['perf'], ['perf', 'ci'], 'all')).toBe(false);
  });

  it('"none" negates overlap, never containment', () => {
    expect(matchTags(['ci'], ['perf'], 'none')).toBe(true);
    // Carrying all but one named label still overlaps, so "none" excludes it —
    // negating "all" here would wrongly admit this row.
    expect(matchTags(['perf'], ['perf', 'ci'], 'none')).toBe(false);
  });

  it('treats a null value array as carrying no labels', () => {
    expect(matchTags(null, ['perf'], 'any')).toBe(false);
    expect(matchTags(null, ['perf'], 'none')).toBe(true);
  });
});

describe('isGroomCandidate', () => {
  it('excludes protected memories unconditionally', () => {
    const m = memory({ protected: true });
    expect(isGroomCandidate(m, conditions({ scope: 'global' }), NOW)).toBe(false);
  });

  it('excludes a memory whose scope the policy does not reach', () => {
    const m = memory({ scope: 'project::other' });
    expect(isGroomCandidate(m, conditions({ scope: 'project::x' }), NOW)).toBe(false);
  });

  it('min_age_days: excludes a memory younger than the threshold', () => {
    const m = memory({ created_at: '2026-08-20T00:00:00.000Z' }); // 6 days old at NOW
    expect(isGroomCandidate(m, conditions({ scope: 'global', min_age_days: 30 }), NOW)).toBe(false);
  });

  it('min_age_days: includes a memory at or beyond the threshold', () => {
    const m = memory({ created_at: '2026-01-01T00:00:00.000Z' });
    expect(isGroomCandidate(m, conditions({ scope: 'global', min_age_days: 30 }), NOW)).toBe(true);
  });

  it('unseen_days: a never-opened memory (null last_opened_at) matches ANY threshold', () => {
    const m = memory({ last_opened_at: null, created_at: NOW.toISOString() });
    expect(isGroomCandidate(m, conditions({ scope: 'global', unseen_days: 1 }), NOW)).toBe(true);
    expect(isGroomCandidate(m, conditions({ scope: 'global', unseen_days: 3650 }), NOW)).toBe(true);
  });

  it('unseen_days: a recently-opened memory does NOT match', () => {
    const m = memory({ last_opened_at: '2026-08-25T00:00:00.000Z' }); // opened yesterday
    expect(isGroomCandidate(m, conditions({ scope: 'global', unseen_days: 14 }), NOW)).toBe(false);
  });

  it('unseen_days: a memory unopened long enough matches', () => {
    const m = memory({ last_opened_at: '2026-01-01T00:00:00.000Z' });
    expect(isGroomCandidate(m, conditions({ scope: 'global', unseen_days: 14 }), NOW)).toBe(true);
  });

  it('max_seen_count: excludes a memory that recurred too many times', () => {
    const m = memory({ seen_count: 10 });
    expect(isGroomCandidate(m, conditions({ scope: 'global', max_seen_count: 3 }), NOW)).toBe(false);
  });

  it('max_seen_count: includes a memory at or below the threshold', () => {
    const m = memory({ seen_count: 3 });
    expect(isGroomCandidate(m, conditions({ scope: 'global', max_seen_count: 3 }), NOW)).toBe(true);
  });

  it('tags: "all" excludes a memory missing one of the named labels', () => {
    const m = memory({ tags: ['perf'] });
    expect(isGroomCandidate(m, conditions({ scope: 'global', tags: ['perf', 'ci'], tags_mode: 'all' }), NOW)).toBe(false);
  });

  it('host: "nin" excludes the named host and includes every other', () => {
    const matching = memory({ host: 'reviewer' });
    const other = memory({ host: 'aw' });
    const c = conditions({ scope: 'global', host: ['reviewer'], host_mode: 'nin' });
    expect(isGroomCandidate(matching, c, NOW)).toBe(false);
    expect(isGroomCandidate(other, c, NOW)).toBe(true);
  });

  it('origin_pr: matches the digit-string form of the integer column', () => {
    const m = memory({ origin_pr: 482 });
    expect(isGroomCandidate(m, conditions({ scope: 'global', origin_pr: ['482'] }), NOW)).toBe(true);
    expect(isGroomCandidate(m, conditions({ scope: 'global', origin_pr: ['111'] }), NOW)).toBe(false);
  });

  it('ANDs every supplied condition, including dimension filters', () => {
    const m = memory({ created_at: '2026-01-01T00:00:00.000Z', last_opened_at: null, seen_count: 1, kind: 'lesson' });
    const c = conditions({ scope: 'global', min_age_days: 30, unseen_days: 30, max_seen_count: 5, kind: ['lesson'] });
    expect(isGroomCandidate(m, c, NOW)).toBe(true);
    // Fails just the kind leg.
    expect(isGroomCandidate({ ...m, kind: 'signal' }, c, NOW)).toBe(false);
  });

  it('with no conditions supplied at all, every non-protected in-scope memory matches', () => {
    const m = memory();
    expect(isGroomCandidate(m, conditions({ scope: 'global' }), NOW)).toBe(true);
  });
});

describe('groomCandidates', () => {
  it('filters a set down to the matching subset, preserving order', () => {
    const memories = [
      memory({ id: 'a', key: 'a', scope: 'global' }),
      memory({ id: 'b', key: 'b', scope: 'global', protected: true }),
      memory({ id: 'c', key: 'c', scope: 'project::x' }),
    ];
    const result = groomCandidates(memories, conditions({ scope: 'global' }), NOW);
    expect(result.map((m) => m.id)).toEqual(['a', 'c']);
  });
});
