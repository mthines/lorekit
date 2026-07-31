import { describe, it, expect } from 'vitest';
import {
  EMPTY_ORIGIN,
  ORIGIN_BRANCH_MAX,
  ORIGIN_PR_MAX,
  ORIGIN_REPO_MAX,
  OriginError,
  hasOrigin,
  parseOrigin,
  parseOriginBranch,
  parseOriginCommit,
  parseOriginPr,
  parseOriginRepo,
} from './origin.js';

describe('parseOriginRepo', () => {
  it('returns null when absent, null, or blank', () => {
    expect(parseOriginRepo(undefined)).toBeNull();
    expect(parseOriginRepo(null)).toBeNull();
    expect(parseOriginRepo('   ')).toBeNull();
  });

  it('lowercases and trims a valid owner/name', () => {
    expect(parseOriginRepo('  MThines/LoreKit ')).toBe('mthines/lorekit');
  });

  it('accepts dots, dashes and underscores', () => {
    expect(parseOriginRepo('my-org/some.repo_name')).toBe('my-org/some.repo_name');
  });

  it.each([
    ['no slash', 'lorekit'],
    ['too many segments', 'a/b/c'],
    ['spaces', 'my org/repo'],
    ['a full URL', 'https://github.com/mthines/lorekit'],
    ['a quote (PostgREST filter injection shape)', 'mthines/lore"kit'],
    ['a comma', 'mthines/lore,kit'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseOriginRepo(value)).toThrow(OriginError);
  });

  it('rejects a non-string', () => {
    expect(() => parseOriginRepo(42)).toThrow(/must be a string/);
  });

  it('rejects an over-long value', () => {
    const long = `${'a'.repeat(ORIGIN_REPO_MAX)}/b`;
    expect(() => parseOriginRepo(long)).toThrow(/<= 140 characters/);
  });
});

describe('parseOriginBranch', () => {
  it('returns null when absent or blank', () => {
    expect(parseOriginBranch(undefined)).toBeNull();
    expect(parseOriginBranch('')).toBeNull();
  });

  it('preserves case so the GitHub /tree/ link resolves', () => {
    expect(parseOriginBranch('feat/Origin-Provenance')).toBe('feat/Origin-Provenance');
  });

  it.each([
    ['spaces', 'feat/my branch'],
    ['a leading slash', '/feat/x'],
    ['a trailing slash', 'feat/x/'],
    ['a path traversal', 'feat/../../etc'],
    ['a tilde', 'feat/x~1'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseOriginBranch(value)).toThrow(OriginError);
  });

  it('rejects an over-long value', () => {
    expect(() => parseOriginBranch('a'.repeat(ORIGIN_BRANCH_MAX + 1))).toThrow(/<= 255 characters/);
  });
});

describe('parseOriginCommit', () => {
  it('returns null when absent or blank', () => {
    expect(parseOriginCommit(undefined)).toBeNull();
    expect(parseOriginCommit('  ')).toBeNull();
  });

  it('lowercases a full SHA', () => {
    const sha = 'A'.repeat(40);
    expect(parseOriginCommit(sha)).toBe('a'.repeat(40));
  });

  it('accepts an abbreviated SHA of at least 7 characters', () => {
    expect(parseOriginCommit('1a2b3c4')).toBe('1a2b3c4');
  });

  it.each([
    ['too short', '1a2b3c'],
    ['too long', 'a'.repeat(41)],
    ['non-hex', 'zzzzzzz'],
    ['a ref name', 'HEAD'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseOriginCommit(value)).toThrow(OriginError);
  });
});

describe('parseOriginPr', () => {
  it('returns null when absent or blank', () => {
    expect(parseOriginPr(undefined)).toBeNull();
    expect(parseOriginPr(null)).toBeNull();
    expect(parseOriginPr('')).toBeNull();
  });

  it('accepts a positive integer', () => {
    expect(parseOriginPr(482)).toBe(482);
  });

  it('coerces a numeric string (env vars arrive as strings)', () => {
    expect(parseOriginPr('482')).toBe(482);
  });

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above int4', ORIGIN_PR_MAX + 1],
    ['a non-numeric string', 'pull/482'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseOriginPr(value)).toThrow(OriginError);
  });
});

describe('parseOrigin', () => {
  it('returns an all-null origin when nothing is supplied', () => {
    expect(parseOrigin({})).toEqual(EMPTY_ORIGIN);
    expect(hasOrigin(parseOrigin({}))).toBe(false);
  });

  it('normalises every field independently', () => {
    expect(
      parseOrigin({
        origin_repo: 'MThines/LoreKit',
        origin_branch: 'feat/Origin',
        origin_commit: 'ABCDEF1234567890',
        origin_pr: '7',
      }),
    ).toEqual({
      repo: 'mthines/lorekit',
      branch: 'feat/Origin',
      commit: 'abcdef1234567890',
      pr: 7,
    });
  });

  it('allows a partial origin (branch known, PR not yet opened)', () => {
    const origin = parseOrigin({ origin_repo: 'mthines/lorekit', origin_branch: 'feat/x' });
    expect(origin).toEqual({ repo: 'mthines/lorekit', branch: 'feat/x', commit: null, pr: null });
    expect(hasOrigin(origin)).toBe(true);
  });

  it('rejects the whole write when one field is malformed', () => {
    expect(() => parseOrigin({ origin_repo: 'mthines/lorekit', origin_pr: -3 })).toThrow(OriginError);
  });
});
