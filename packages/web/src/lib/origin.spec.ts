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

  it('refuse a repo with a relative path segment — it would retarget the link', () => {
    // https://github.com/../evil resolves in the browser to github.com/evil.
    expect(originRepoUrl({ origin_repo: '../evil' })).toBeNull();
    expect(originRepoUrl({ origin_repo: './evil' })).toBeNull();
    expect(originRepoUrl({ origin_repo: 'owner/..' })).toBeNull();
    expect(originPullRequestUrl({ origin_repo: '../evil', origin_pr: 1 })).toBeNull();
  });

  it('refuse a branch with a .. segment — encodeURIComponent leaves it intact', () => {
    expect(originBranchUrl({ origin_repo: 'a/b', origin_branch: 'feat/../../x' })).toBeNull();
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

  it('lists every known origin, context-first, when no scope is given', () => {
    expect(originLinks(FULL)).toEqual([
      { kind: 'repo', label: 'mthines/lorekit', url: 'https://github.com/mthines/lorekit' },
      { kind: 'pull-request', label: '#482', url: 'https://github.com/mthines/lorekit/pull/482' },
      { kind: 'branch', label: 'feat/Origin-Provenance', url: 'https://github.com/mthines/lorekit/tree/feat/Origin-Provenance' },
      { kind: 'commit', label: 'abc1234', url: 'https://github.com/mthines/lorekit/commit/abc1234def5678' },
    ]);
  });

  it('renders the repo link on its own when nothing more specific is known', () => {
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
    expect(
      originLinks({ origin_repo: 'a/b', origin_branch: 'feat/x' }, 'repo::a/b').map((l) => l.kind),
    ).toEqual(['branch']);
  });
});

// The rules that keep the origin rows COMPLEMENTARY to the scope-derived
// "Repo" metadata row (`scopeRepoUrl`) rather than a second copy of it.
describe('originLinks — complements the scope, never repeats it', () => {
  it('drops the repo row when the scope already names the same repo', () => {
    expect(originLinks(FULL, 'repo::mthines/lorekit').map((l) => l.kind)).toEqual([
      'pull-request',
      'branch',
      'commit',
    ]);
  });

  it('matches the scope repo case-insensitively (scopes are lowercased)', () => {
    expect(
      originLinks({ origin_repo: 'MThines/LoreKit' }, 'repo::mthines/lorekit'),
    ).toEqual([]);
  });

  it('keeps the repo row for a global lesson — its scope names no repo', () => {
    expect(originLinks(FULL, 'global')[0]).toEqual({
      kind: 'repo',
      label: 'mthines/lorekit',
      url: 'https://github.com/mthines/lorekit',
    });
  });

  it('keeps the repo row when the lesson was recorded in a DIFFERENT repo', () => {
    expect(originLinks(FULL, 'repo::acme/other').map((l) => l.kind)).toEqual([
      'repo',
      'pull-request',
      'branch',
      'commit',
    ]);
  });

  it("drops the branch row when a branch:: scope already links that branch", () => {
    expect(
      originLinks(
        { origin_repo: 'mthines/lorekit', origin_branch: 'feat/x' },
        'branch::mthines/lorekit::feat/x',
      ),
    ).toEqual([]);
  });

  it('keeps a branch that differs from the one the scope names', () => {
    expect(
      originLinks(
        { origin_repo: 'mthines/lorekit', origin_branch: 'feat/y' },
        'branch::mthines/lorekit::feat/x',
      ).map((l) => l.kind),
    ).toEqual(['branch']);
  });

  it('keeps a same-named branch of a different repo — it is a different branch', () => {
    expect(
      originLinks(
        { origin_repo: 'acme/other', origin_branch: 'feat/x' },
        'branch::mthines/lorekit::feat/x',
      ).map((l) => l.kind),
    ).toEqual(['repo', 'branch']);
  });

  it('never suppresses a pull request or commit — no scope can express them', () => {
    expect(
      originLinks(
        { origin_repo: 'mthines/lorekit', origin_branch: 'feat/x', origin_commit: 'abc1234', origin_pr: 7 },
        'branch::mthines/lorekit::feat/x',
      ).map((l) => l.kind),
    ).toEqual(['pull-request', 'commit']);
  });

  it('is unaffected by a project/malformed scope, which names no repo', () => {
    expect(originLinks(FULL, 'project::lorekit').map((l) => l.kind)).toEqual([
      'repo',
      'pull-request',
      'branch',
      'commit',
    ]);
    expect(originLinks(FULL, 'repo::not-a-repo').map((l) => l.kind)).toContain('repo');
  });
});
