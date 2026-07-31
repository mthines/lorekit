import { describe, it, expect } from 'vitest';
import {
  originBranchUrl,
  originCommitUrl,
  originLinks,
  originPullRequestUrl,
  originRepoUrl,
  shortSha,
} from './origin';

const FULL = {
  origin_repo: 'mthines/lorekit',
  origin_branch: 'feat/Origin-Provenance',
  origin_commit: 'abc1234def5678',
  origin_pr: 482,
};

describe('url builders', () => {
  it('build every GitHub URL from a fully-populated origin', () => {
    expect(originRepoUrl(FULL)).toBe('https://github.com/mthines/lorekit');
    expect(originPullRequestUrl(FULL)).toBe('https://github.com/mthines/lorekit/pull/482');
    expect(originBranchUrl(FULL)).toBe('https://github.com/mthines/lorekit/tree/feat/Origin-Provenance');
    expect(originCommitUrl(FULL)).toBe('https://github.com/mthines/lorekit/commit/abc1234def5678');
  });

  it('preserve branch case so the /tree/ link resolves', () => {
    expect(originBranchUrl({ origin_repo: 'a/b', origin_branch: 'Feat/X' })).toBe('https://github.com/a/b/tree/Feat/X');
  });

  it('percent-encode a branch segment without escaping the path separators', () => {
    expect(originBranchUrl({ origin_repo: 'a/b', origin_branch: 'feat/a b' })).toBe('https://github.com/a/b/tree/feat/a%20b');
  });

  it('return null when the repo is unknown — there is no link target', () => {
    expect(originRepoUrl({ origin_branch: 'main' })).toBeNull();
    expect(originPullRequestUrl({ origin_pr: 7 })).toBeNull();
    expect(originBranchUrl({ origin_branch: 'main' })).toBeNull();
    expect(originCommitUrl({ origin_commit: 'abc1234' })).toBeNull();
  });

  it('return null for a malformed repo rather than a broken href', () => {
    expect(originRepoUrl({ origin_repo: 'not-a-repo' })).toBeNull();
    expect(originRepoUrl({ origin_repo: 'https://github.com/a/b' })).toBeNull();
  });

  it('reject a non-integer or non-positive PR number', () => {
    expect(originPullRequestUrl({ origin_repo: 'a/b', origin_pr: 0 })).toBeNull();
    expect(originPullRequestUrl({ origin_repo: 'a/b', origin_pr: -1 })).toBeNull();
    expect(originPullRequestUrl({ origin_repo: 'a/b', origin_pr: 1.5 })).toBeNull();
  });

  it('reject a non-hex commit', () => {
    expect(originCommitUrl({ origin_repo: 'a/b', origin_commit: 'HEAD' })).toBeNull();
  });
});

describe('shortSha', () => {
  it('truncates to the git short form', () => {
    expect(shortSha('abc1234def5678')).toBe('abc1234');
  });

  it('leaves an already-short sha alone', () => {
    expect(shortSha('abc1234')).toBe('abc1234');
  });
});

describe('originLinks', () => {
  it('returns nothing for a row with no origin', () => {
    expect(originLinks({})).toEqual([]);
  });

  it('orders most-specific first and omits the redundant repo link', () => {
    expect(originLinks(FULL)).toEqual([
      { kind: 'pull-request', label: '#482', url: 'https://github.com/mthines/lorekit/pull/482' },
      { kind: 'branch', label: 'feat/Origin-Provenance', url: 'https://github.com/mthines/lorekit/tree/feat/Origin-Provenance' },
      { kind: 'commit', label: 'abc1234', url: 'https://github.com/mthines/lorekit/commit/abc1234def5678' },
    ]);
  });

  it('falls back to the repo link when nothing more specific is known', () => {
    expect(originLinks({ origin_repo: 'mthines/lorekit' })).toEqual([
      { kind: 'repo', label: 'mthines/lorekit', url: 'https://github.com/mthines/lorekit' },
    ]);
  });

  it('renders a known branch with no repo as an unlinked chip', () => {
    expect(originLinks({ origin_branch: 'main' })).toEqual([
      { kind: 'branch', label: 'main', url: null },
    ]);
  });

  it('handles the late-binding case: branch known, PR not opened yet', () => {
    expect(originLinks({ origin_repo: 'a/b', origin_branch: 'feat/x' }).map((l) => l.kind)).toEqual([
      'branch',
    ]);
  });
});
