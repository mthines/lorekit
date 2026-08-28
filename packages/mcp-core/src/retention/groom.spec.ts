import { describe, it, expect } from 'vitest';
import {
  resolvePolicyConditions,
  resolveGroomConditions,
  scopeMatchesPolicy,
  isGroomCandidate,
  groomCandidates,
  type RetentionPolicyRow,
  type GroomCandidateMemory,
} from './groom.js';

const NOW = new Date('2026-08-26T00:00:00.000Z');

function memory(overrides: Partial<GroomCandidateMemory> = {}): GroomCandidateMemory {
  return {
    id: 'm1',
    scope: 'global',
    key: 'k1',
    created_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: null,
    seen_count: 1,
    protected: false,
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
};

describe('resolvePolicyConditions', () => {
  it('projects a policy row onto the conditions struct', () => {
    const policy: RetentionPolicyRow = { ...basePolicy, scope: 'repo::acme/app', min_age_days: 30, unseen_days: 14, max_seen_count: 2 };
    expect(resolvePolicyConditions(policy)).toEqual({
      scope: 'repo::acme/app', min_age_days: 30, unseen_days: 14, max_seen_count: 2,
    });
  });
});

describe('resolveGroomConditions', () => {
  it('resolves a policy_id request using the fetched row', () => {
    const policy: RetentionPolicyRow = { ...basePolicy, scope: 'global', min_age_days: 7 };
    const result = resolveGroomConditions({ policy_id: 'p1' }, policy);
    expect(result).toEqual({ scope: 'global', min_age_days: 7, unseen_days: null, max_seen_count: null });
  });

  it('throws when a policy_id request has no matching row', () => {
    expect(() => resolveGroomConditions({ policy_id: 'missing' }, null)).toThrow(/no policy found/);
  });

  it('resolves an inline request without a policy row', () => {
    const result = resolveGroomConditions({ scope: 'project::x', min_age_days: 10 }, null);
    expect(result).toEqual({ scope: 'project::x', min_age_days: 10, unseen_days: null, max_seen_count: null });
  });

  it('defaults omitted inline conditions to null, not undefined', () => {
    const result = resolveGroomConditions({ scope: 'global' }, null);
    expect(result).toEqual({ scope: 'global', min_age_days: null, unseen_days: null, max_seen_count: null });
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

describe('isGroomCandidate', () => {
  it('excludes protected memories unconditionally', () => {
    const m = memory({ protected: true });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: null, max_seen_count: null }, NOW)).toBe(false);
  });

  it('excludes a memory whose scope the policy does not reach', () => {
    const m = memory({ scope: 'project::other' });
    expect(isGroomCandidate(m, { scope: 'project::x', min_age_days: null, unseen_days: null, max_seen_count: null }, NOW)).toBe(false);
  });

  it('min_age_days: excludes a memory younger than the threshold', () => {
    const m = memory({ created_at: '2026-08-20T00:00:00.000Z' }); // 6 days old at NOW
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: 30, unseen_days: null, max_seen_count: null }, NOW)).toBe(false);
  });

  it('min_age_days: includes a memory at or beyond the threshold', () => {
    const m = memory({ created_at: '2026-01-01T00:00:00.000Z' });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: 30, unseen_days: null, max_seen_count: null }, NOW)).toBe(true);
  });

  it('unseen_days: a never-seen memory (null last_seen_at) matches ANY threshold', () => {
    const m = memory({ last_seen_at: null, created_at: NOW.toISOString() });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: 1, max_seen_count: null }, NOW)).toBe(true);
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: 3650, max_seen_count: null }, NOW)).toBe(true);
  });

  it('unseen_days: a recently-seen memory does NOT match', () => {
    const m = memory({ last_seen_at: '2026-08-25T00:00:00.000Z' }); // seen yesterday
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: 14, max_seen_count: null }, NOW)).toBe(false);
  });

  it('unseen_days: a memory unseen long enough matches', () => {
    const m = memory({ last_seen_at: '2026-01-01T00:00:00.000Z' });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: 14, max_seen_count: null }, NOW)).toBe(true);
  });

  it('max_seen_count: excludes a memory that recurred too many times', () => {
    const m = memory({ seen_count: 10 });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: null, max_seen_count: 3 }, NOW)).toBe(false);
  });

  it('max_seen_count: includes a memory at or below the threshold', () => {
    const m = memory({ seen_count: 3 });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: null, max_seen_count: 3 }, NOW)).toBe(true);
  });

  it('ANDs every supplied condition', () => {
    const m = memory({ created_at: '2026-01-01T00:00:00.000Z', last_seen_at: null, seen_count: 1 });
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: 30, unseen_days: 30, max_seen_count: 5 }, NOW)).toBe(true);
    // Fails just the seen_count leg.
    expect(isGroomCandidate({ ...m, seen_count: 100 }, { scope: 'global', min_age_days: 30, unseen_days: 30, max_seen_count: 5 }, NOW)).toBe(false);
  });

  it('with no conditions supplied at all, every non-protected in-scope memory matches', () => {
    const m = memory();
    expect(isGroomCandidate(m, { scope: 'global', min_age_days: null, unseen_days: null, max_seen_count: null }, NOW)).toBe(true);
  });
});

describe('groomCandidates', () => {
  it('filters a set down to the matching subset, preserving order', () => {
    const memories = [
      memory({ id: 'a', key: 'a', scope: 'global' }),
      memory({ id: 'b', key: 'b', scope: 'global', protected: true }),
      memory({ id: 'c', key: 'c', scope: 'project::x' }),
    ];
    const result = groomCandidates(memories, { scope: 'global', min_age_days: null, unseen_days: null, max_seen_count: null }, NOW);
    expect(result.map((m) => m.id)).toEqual(['a', 'c']);
  });
});
