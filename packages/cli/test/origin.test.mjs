// Provenance derivation: `deriveOrigin` / `prNumberFromEnv` / `mergeOrigin`.
//
// The git runner and the environment are both injected, so every case here is
// deterministic — no real repository, no real CI runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOrigin, isValidRef, isValidRepo, mergeOrigin, prNumberFromEnv } from '../src/origin.mjs';

/** A fake `git` that answers from a lookup table and returns null otherwise. */
function fakeGit(answers) {
  return (args) => answers[args.join(' ')] ?? null;
}

const GIT = fakeGit({
  'config --get remote.origin.url': 'git@github.com:MThines/LoreKit.git',
  'rev-parse --abbrev-ref HEAD': 'feat/Origin-Provenance',
  'rev-parse HEAD': 'a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d',
});

test('deriveOrigin reads repo, branch and commit from git', () => {
  const origin = deriveOrigin({ cwd: '/tmp', env: {}, run: GIT });
  assert.deepEqual(origin, {
    origin_repo: 'mthines/lorekit',
    origin_branch: 'feat/Origin-Provenance',
    origin_commit: 'a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d',
    origin_pr: null,
  });
});

test('deriveOrigin preserves branch case so the GitHub /tree/ link resolves', () => {
  const { origin_branch: branch } = deriveOrigin({ env: {}, run: GIT });
  assert.equal(branch, 'feat/Origin-Provenance');
});

test('deriveOrigin degrades to all-null outside a git repository', () => {
  const origin = deriveOrigin({ env: {}, run: () => null });
  assert.deepEqual(origin, {
    origin_repo: null,
    origin_branch: null,
    origin_commit: null,
    origin_pr: null,
  });
});

test('deriveOrigin drops a detached HEAD rather than recording it as a branch', () => {
  const run = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'HEAD' });
  assert.equal(deriveOrigin({ env: {}, run }).origin_branch, null);
});

test('deriveOrigin prefers GITHUB_HEAD_REF over the detached PR merge checkout', () => {
  const run = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'HEAD' });
  const env = { GITHUB_HEAD_REF: 'feat/from-actions', GITHUB_REPOSITORY: 'MThines/LoreKit' };
  const origin = deriveOrigin({ env, run });
  assert.equal(origin.origin_branch, 'feat/from-actions');
  assert.equal(origin.origin_repo, 'mthines/lorekit');
});

test('deriveOrigin falls back to GITHUB_SHA when git is unavailable', () => {
  const env = { GITHUB_SHA: 'deadbeef1234567890' };
  assert.equal(deriveOrigin({ env, run: () => null }).origin_commit, 'deadbeef1234567890');
});

test('deriveOrigin honours the LOREKIT_* overrides above everything else', () => {
  const env = {
    LOREKIT_REPO: 'Other/Repo',
    LOREKIT_BRANCH: 'override-branch',
    LOREKIT_COMMIT: 'cafebabe1234',
    LOREKIT_PR: '9',
    GITHUB_HEAD_REF: 'ignored',
  };
  assert.deepEqual(deriveOrigin({ env, run: () => null }), {
    origin_repo: 'other/repo',
    origin_branch: 'override-branch',
    origin_commit: 'cafebabe1234',
    origin_pr: 9,
  });
});

test('deriveOrigin ignores a malformed GITHUB_REPOSITORY', () => {
  assert.equal(deriveOrigin({ env: { GITHUB_REPOSITORY: 'nope' }, run: () => null }).origin_repo, null);
});

test('prNumberFromEnv reads a GitHub Actions pull_request ref', () => {
  assert.equal(prNumberFromEnv({ GITHUB_REF: 'refs/pull/482/merge' }), 482);
});

test('prNumberFromEnv ignores a branch ref', () => {
  assert.equal(prNumberFromEnv({ GITHUB_REF: 'refs/heads/main' }), null);
});

test('prNumberFromEnv prefers the explicit LOREKIT_PR escape hatch', () => {
  assert.equal(prNumberFromEnv({ LOREKIT_PR: '7', GITHUB_REF: 'refs/pull/482/merge' }), 7);
});

test('prNumberFromEnv rejects a non-positive or non-integer value', () => {
  for (const v of ['0', '-1', '1.5', 'abc', '']) {
    assert.equal(prNumberFromEnv({ LOREKIT_PR: v }), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('mergeOrigin lets an explicit override win over the derived value', () => {
  const derived = { origin_repo: 'a/b', origin_branch: 'derived', origin_commit: null, origin_pr: null };
  assert.deepEqual(mergeOrigin(derived, { origin_branch: 'explicit', origin_pr: 3 }), {
    origin_repo: 'a/b',
    origin_branch: 'explicit',
    origin_pr: 3,
  });
});

test('mergeOrigin omits unknown fields entirely — never sends null', () => {
  const merged = mergeOrigin({ origin_branch: 'x' }, {});
  assert.deepEqual(Object.keys(merged), ['origin_branch']);
  assert.equal('origin_pr' in merged, false);
});

test('mergeOrigin on an empty derivation is an empty object', () => {
  assert.deepEqual(mergeOrigin({}, {}), {});
});

test('isValidRef accepts the exotic-but-legal git ref names an allow list would reject', () => {
  for (const ref of ['feat/add+x', 'fix/issue#123', 'release/1.0(rc)', 'feat/café', 'user@host/x', 'a&b']) {
    assert.equal(isValidRef(ref), true, `expected ${ref} to be a valid ref`);
  }
});

test('isValidRef rejects what git itself rejects', () => {
  for (const ref of ['has space', 'has~tilde', 'has^caret', 'has:colon', 'has?q', 'has*star', 'has[bracket', 'back\\slash', '/leading', 'trailing/', '.leading', 'trailing.', 'x.lock', 'a..b', 'a//b', 'a@{b', '']) {
    assert.equal(isValidRef(ref), false, `expected ${JSON.stringify(ref)} to be rejected`);
  }
});

test('deriveOrigin drops a derived branch git would reject rather than sending it', () => {
  const run = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'bad branch' });
  assert.equal(deriveOrigin({ env: {}, run }).origin_branch, null);
});

test('deriveOrigin keeps an exotic-but-legal branch name', () => {
  const run = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'fix/issue#123' });
  assert.equal(deriveOrigin({ env: {}, run }).origin_branch, 'fix/issue#123');
});

test('deriveOrigin drops a commit that is not a hex SHA', () => {
  const run = fakeGit({ 'rev-parse HEAD': 'not-a-sha' });
  assert.equal(deriveOrigin({ env: {}, run }).origin_commit, null);
});

test('deriveOrigin lowercases the commit SHA', () => {
  const run = fakeGit({ 'rev-parse HEAD': 'ABC1234DEF' });
  assert.equal(deriveOrigin({ env: {}, run }).origin_commit, 'abc1234def');
});

test('deriveOrigin takes the PR head commit, not the merge commit, on a merge checkout', () => {
  // On a GitHub Actions pull_request run HEAD is a detached merge commit that
  // exists on neither branch, so branch and commit would name different refs.
  const run = fakeGit({
    'rev-parse --abbrev-ref HEAD': 'HEAD',
    'rev-parse HEAD': 'aaaaaaaaaaaaaaaa',
    'rev-parse HEAD^2': 'bbbbbbbbbbbbbbbb',
  });
  const origin = deriveOrigin({ env: { GITHUB_HEAD_REF: 'feat/x', GITHUB_SHA: 'aaaaaaaaaaaaaaaa' }, run });
  assert.equal(origin.origin_branch, 'feat/x');
  assert.equal(origin.origin_commit, 'bbbbbbbbbbbbbbbb');
});

test('deriveOrigin records no commit rather than a mismatched one on a shallow merge checkout', () => {
  // actions/checkout's default fetch-depth: 1 has no second parent to resolve.
  const run = fakeGit({
    'rev-parse --abbrev-ref HEAD': 'HEAD',
    'rev-parse HEAD': 'aaaaaaaaaaaaaaaa',
  });
  const origin = deriveOrigin({ env: { GITHUB_HEAD_REF: 'feat/x', GITHUB_SHA: 'aaaaaaaaaaaaaaaa' }, run });
  assert.equal(origin.origin_branch, 'feat/x');
  assert.equal(origin.origin_commit, null, 'GITHUB_SHA is the merge commit here and must not be used');
});

test('deriveOrigin still uses GITHUB_SHA off a merge checkout', () => {
  const origin = deriveOrigin({ env: { GITHUB_SHA: 'deadbeef1234' }, run: () => null });
  assert.equal(origin.origin_commit, 'deadbeef1234');
});

test('deriveOrigin runs git in the directory it was given, not the process cwd', () => {
  const seen = [];
  const run = (args, cwd) => {
    seen.push(cwd);
    return null;
  };
  deriveOrigin({ cwd: '/some/repo', env: {}, run });
  assert.deepEqual([...new Set(seen)], ['/some/repo']);
});

test('isValidRepo enforces the same rule as the server validator', () => {
  assert.equal(isValidRepo('MThines/LoreKit'), 'mthines/lorekit');
  assert.equal(isValidRepo('my-org/some.repo_name'), 'my-org/some.repo_name');
  for (const bad of ['lorekit', 'a/b/c', 'my org/repo', '../evil', 'owner/..', './x', '', null, 42]) {
    assert.equal(isValidRepo(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('deriveOrigin drops a remote-derived repo the server would reject', () => {
  // `ownerRepoFromRemote` parses whatever the remote happens to be; sending an
  // unusable value would 400 the write this provenance only decorates.
  const run = fakeGit({ 'config --get remote.origin.url': 'git@github.com:evil/../weird.git' });
  assert.equal(deriveOrigin({ env: {}, run }).origin_repo, null);
});

test('deriveOrigin falls back to GITHUB_REPOSITORY when the remote is unusable', () => {
  const run = fakeGit({ 'config --get remote.origin.url': 'not-a-url' });
  const origin = deriveOrigin({ env: { GITHUB_REPOSITORY: 'MThines/LoreKit' }, run });
  assert.equal(origin.origin_repo, 'mthines/lorekit');
});

test('LOREKIT_REPO wins over the git remote, like every other LOREKIT_ override', () => {
  const run = fakeGit({ 'config --get remote.origin.url': 'git@github.com:MThines/LoreKit.git' });
  const origin = deriveOrigin({ env: { LOREKIT_REPO: 'other/repo' }, run });
  assert.equal(origin.origin_repo, 'other/repo');
});

test('an unusable remote falls through to GITHUB_REPOSITORY instead of shadowing it', () => {
  const run = fakeGit({ 'config --get remote.origin.url': 'git@github.com:evil/../weird.git' });
  const origin = deriveOrigin({ env: { GITHUB_REPOSITORY: 'MThines/LoreKit' }, run });
  assert.equal(origin.origin_repo, 'mthines/lorekit');
});

test('an unusable LOREKIT_REPO falls through to the git remote', () => {
  const run = fakeGit({ 'config --get remote.origin.url': 'git@github.com:MThines/LoreKit.git' });
  const origin = deriveOrigin({ env: { LOREKIT_REPO: 'not-a-repo' }, run });
  assert.equal(origin.origin_repo, 'mthines/lorekit');
});
