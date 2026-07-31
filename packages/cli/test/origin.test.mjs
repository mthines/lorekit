// Provenance derivation: `deriveOrigin` / `prNumberFromEnv` / `mergeOrigin`.
//
// The git runner and the environment are both injected, so every case here is
// deterministic — no real repository, no real CI runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOrigin, hasOrigin, mergeOrigin, prNumberFromEnv } from '../src/origin.mjs';

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
  assert.equal(hasOrigin(origin), false);
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
