import { describe, it, expect } from 'vitest';
import {
  SCOPE_PRECEDENCE,
  scopePrecedenceRank,
  compareScopePrecedence,
  pickScopeWinner,
  shadowedScopes,
} from './scope-precedence.js';

/**
 * The rule an UNSCOPED read resolves by.
 *
 * These assertions are the contract three surfaces depend on — MCP
 * `memory.read`, the REST list route the CLI's remote `show` reads through, and
 * the CLI's offline store. The reason it is pinned this hard is that the
 * failure mode is silent: a precedence that changed would not error, it would
 * hand the same `memory.read { key }` call a DIFFERENT lesson than it did
 * yesterday.
 */
describe('scopePrecedenceRank', () => {
  it('ranks the four scope types in the hook engine\'s readOrder', () => {
    expect(SCOPE_PRECEDENCE).toEqual(['project', 'branch', 'repo', 'global']);
    expect(scopePrecedenceRank('project::lorekit')).toBe(0);
    expect(scopePrecedenceRank('branch::o/r::feat/x')).toBe(1);
    expect(scopePrecedenceRank('repo::o/r')).toBe(2);
    expect(scopePrecedenceRank('global')).toBe(3);
  });

  it('ranks an unrecognised scope LAST instead of throwing', () => {
    // A read that FOUND something must never fail on how it is ordered — so an
    // unknown prefix degrades to the broadest band rather than raising.
    expect(scopePrecedenceRank('nonsense::x')).toBe(SCOPE_PRECEDENCE.length);
    expect(scopePrecedenceRank('')).toBe(SCOPE_PRECEDENCE.length);
    expect(scopePrecedenceRank(undefined as unknown as string)).toBe(SCOPE_PRECEDENCE.length);
  });

  it('is case- and whitespace-insensitive on the prefix', () => {
    expect(scopePrecedenceRank('  Repo::O/R  ')).toBe(2);
  });
});

describe('pickScopeWinner', () => {
  const row = (scope: string, updated_at?: string) => ({ scope, updated_at });

  it('prefers the more specific scope over the broader one', () => {
    expect(pickScopeWinner([row('global'), row('repo::o/r')])?.scope).toBe('repo::o/r');
    expect(pickScopeWinner([row('repo::o/r'), row('project::p')])?.scope).toBe('project::p');
  });

  it('is independent of input order', () => {
    const rows = [row('global'), row('branch::o/r::b'), row('repo::o/r'), row('project::p')];
    expect(pickScopeWinner(rows)?.scope).toBe('project::p');
    expect(pickScopeWinner([...rows].reverse())?.scope).toBe('project::p');
  });

  it('breaks a same-band tie by most-recently-updated', () => {
    const winner = pickScopeWinner([
      row('repo::o/old', '2026-01-01T00:00:00.000Z'),
      row('repo::o/new', '2026-09-01T00:00:00.000Z'),
    ]);
    expect(winner?.scope).toBe('repo::o/new');
  });

  it('breaks a same-band, same-timestamp tie by scope ascending', () => {
    const ts = '2026-09-01T00:00:00.000Z';
    // Without this the "winner" would be whatever order Postgres returned, and
    // the same call would answer differently on consecutive runs.
    expect(pickScopeWinner([row('repo::o/b', ts), row('repo::o/a', ts)])?.scope).toBe('repo::o/a');
    expect(pickScopeWinner([row('repo::o/a', ts), row('repo::o/b', ts)])?.scope).toBe('repo::o/a');
  });

  it('sorts a row with no timestamp after one that has one, in the same band', () => {
    expect(pickScopeWinner([row('repo::o/a'), row('repo::o/b', '2020-01-01T00:00:00.000Z')])?.scope)
      .toBe('repo::o/b');
  });

  it('returns null for an empty or non-array input', () => {
    expect(pickScopeWinner([])).toBeNull();
    expect(pickScopeWinner(undefined as unknown as [])).toBeNull();
  });

  it('does not mutate the input', () => {
    const rows = [row('global'), row('repo::o/r')];
    const before = [...rows];
    pickScopeWinner(rows);
    expect(rows).toEqual(before);
  });
});

describe('compareScopePrecedence', () => {
  it('is a total order — sorting is stable and reproducible', () => {
    const rows = [
      { scope: 'global', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'repo::o/r', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'branch::o/r::b', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'project::p', updated_at: '2026-01-01T00:00:00.000Z' },
    ];
    expect([...rows].sort(compareScopePrecedence).map((r) => r.scope)).toEqual([
      'project::p',
      'branch::o/r::b',
      'repo::o/r',
      'global',
    ]);
  });
});

describe('shadowedScopes', () => {
  it('names every OTHER scope the key matched, in precedence order', () => {
    const rows = [
      { scope: 'global', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'repo::o/r', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'project::p', updated_at: '2026-01-01T00:00:00.000Z' },
    ];
    const winner = pickScopeWinner(rows);
    expect(winner?.scope).toBe('project::p');
    expect(shadowedScopes(rows, winner)).toEqual(['repo::o/r', 'global']);
  });

  it('is empty when the key matched exactly one scope', () => {
    const rows = [{ scope: 'global', updated_at: '2026-01-01T00:00:00.000Z' }];
    expect(shadowedScopes(rows, pickScopeWinner(rows))).toEqual([]);
  });

  it('de-duplicates a scope that contributed more than one row', () => {
    const rows = [{ scope: 'repo::o/r' }, { scope: 'repo::o/r' }, { scope: 'global' }];
    expect(shadowedScopes(rows, pickScopeWinner(rows))).toEqual(['global']);
  });

  it('returns empty for a null winner', () => {
    expect(shadowedScopes([{ scope: 'global' }], null)).toEqual([]);
  });
});
