import { describe, it, expect } from 'vitest';
import {
  ORIGIN_BRANCH_MAX,
  ORIGIN_PR_MAX,
  ORIGIN_REPO_MAX,
  OriginError,
  parseOrigin,
  parseOriginBranch,
  parseOriginCommit,
  parseOriginPr,
  parseOriginRepo,
  sanitizeOrigin,
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
    ['a plus', 'feat/add+x'],
    ['a hash', 'fix/issue#123'],
    ['parentheses', 'release/1.0(rc)'],
    ['non-ASCII', 'feat/café'],
    ['an ampersand', 'a&b'],
  ])('accepts %s — git does, and rejecting it would fail the write', (_label, value) => {
    expect(parseOriginBranch(value)).toBe(value);
  });

  it.each([
    ['spaces', 'feat/my branch'],
    ['a tilde', 'feat/x~1'],
    ['a caret', 'feat/x^2'],
    ['a colon', 'feat:x'],
    ['a question mark', 'feat/x?'],
    ['an asterisk', 'feat/*'],
    ['an open bracket', 'feat/[x'],
    ['a backslash', 'feat\\x'],
    ['a leading slash', '/feat/x'],
    ['a trailing slash', 'feat/x/'],
    ['a double slash', 'feat//x'],
    ['a leading dot', '.feat'],
    ['a trailing dot', 'feat.'],
    ['a .lock suffix', 'feat/x.lock'],
    ['a path traversal', 'feat/../../etc'],
    ['a reflog expression', 'feat/x@{1}'],
  ])('rejects %s — git rejects it too', (_label, value) => {
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
    expect(parseOrigin({})).toEqual({ repo: null, branch: null, commit: null, pr: null });
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
  });

  it('rejects the whole write when one field is malformed', () => {
    expect(() => parseOrigin({ origin_repo: 'mthines/lorekit', origin_pr: -3 })).toThrow(OriginError);
  });
});

describe('sanitizeOrigin', () => {
  it('keeps every field of a fully-valid ambient origin, normalised', () => {
    expect(
      sanitizeOrigin({
        origin_repo: 'MThines/LoreKit',
        origin_branch: 'feat/x',
        origin_commit: 'ABC1234',
        origin_pr: '5',
      }),
    ).toEqual({
      origin_repo: 'mthines/lorekit',
      origin_branch: 'feat/x',
      origin_commit: 'abc1234',
      origin_pr: 5,
    });
  });

  it('drops only the malformed field, never the whole origin', () => {
    // A webhook delivery whose head branch git would reject must still record
    // the repo and PR — provenance degrades, the write does not fail.
    expect(
      sanitizeOrigin({
        origin_repo: 'mthines/lorekit',
        origin_branch: 'bad branch',
        origin_pr: 482,
      }),
    ).toEqual({ origin_repo: 'mthines/lorekit', origin_pr: 482 });
  });

  it('omits an unsupplied field rather than emitting null', () => {
    const out = sanitizeOrigin({ origin_pr: 1 });
    expect(out).toEqual({ origin_pr: 1 });
    expect('origin_branch' in out).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    expect(sanitizeOrigin({ origin_repo: 42, origin_pr: 'nope', origin_commit: 'HEAD' })).toEqual({});
  });
});
