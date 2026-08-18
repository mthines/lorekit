#!/usr/bin/env node
// Unit tests for the pure core of the deploy-scope resolver. Runs with the
// built-in runner (`node --test`), no dependencies — same shape as
// check-remote-migration-drift.test.mjs. This logic decides whether the API and
// the web halves reach production, and getting it wrong is what let a web bundle
// front an API that had never been deployed, so it is exactly what a test is for.
// Importing the module must NOT run the git plumbing — the `invokedDirectly`
// seam ensures that (argv[1] ends in `.test.mjs`, not the script's own name).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_PATHS,
  WEB_PATHS,
  classify,
  halfChanged,
  pickBaseline,
  resolveManualTarget,
} from './resolve-deploy-scope.mjs';

// The two merges from the incident, by their real changed-path sets.
const PR_492_FILES = [
  'packages/web/src/lib/api/memories.ts',
  'packages/web/src/lib/filters.ts',
  'packages/schemas/src/memory.ts',
  'supabase/functions/memories/handlers/list.ts',
  'supabase/functions/memories/index.ts',
  'supabase/migrations/00067_memory_list_rpc.sql',
];
const PR_504_FILES = [
  'packages/web/src/lib/otel-deployment-env.ts',
  'packages/web/src/instrumentation.ts',
];

test('a both-halves merge deploys both halves', () => {
  assert.deepEqual(classify({ apiChangedFiles: PR_492_FILES, webChangedFiles: PR_492_FILES }), {
    api: true,
    web: true,
  });
});

test('THE REGRESSION: a web-only merge still deploys the API when the API baseline predates an undeployed API change', () => {
  // What #504 looked like once each half is diffed against what it is SERVING
  // rather than against #504's own parent: the API marker is still the pre-#492
  // commit, so #492's `supabase/**` files are still in the API diff.
  const apiChangedFiles = [...PR_492_FILES, ...PR_504_FILES];
  const webChangedFiles = PR_504_FILES;

  const scope = classify({ apiChangedFiles, webChangedFiles });
  assert.equal(scope.web, true, 'the web half changed and must deploy');
  assert.equal(
    scope.api,
    true,
    'the API half has undeployed work and must deploy — promote-web-production then waits for it',
  );
});

test('BEFORE the fix: the same merge diffed against its own parent skipped the API', () => {
  // Pins why the old rule was unsafe rather than just asserting the new one.
  // `api: false` is precisely what let promote-web-production take its
  // `changes.outputs.api == 'false'` branch and flip ahead of the backend.
  assert.deepEqual(classify({ apiChangedFiles: PR_504_FILES, webChangedFiles: PR_504_FILES }), {
    api: false,
    web: true,
  });
});

test('an API-only merge does not promote the web', () => {
  const files = ['supabase/functions/memories/handlers/get.ts'];
  assert.deepEqual(classify({ apiChangedFiles: files, webChangedFiles: files }), {
    api: true,
    web: false,
  });
});

test('a docs-only merge deploys nothing', () => {
  const files = ['docs/decisions.md', 'README.md', 'CLAUDE.md'];
  assert.deepEqual(classify({ apiChangedFiles: files, webChangedFiles: files }), {
    api: false,
    web: false,
  });
});

test('shared and pipeline paths force both halves', () => {
  for (const f of [
    'packages/schemas/src/memory.ts',
    'pnpm-lock.yaml',
    'package.json',
    'nx.json',
    '.github/workflows/deploy.yml',
    // The resolver itself: a change to the decision must exercise both halves,
    // otherwise a bug in it could only be observed on the half it did not skip.
    'scripts/resolve-deploy-scope.mjs',
  ]) {
    assert.equal(halfChanged([f], API_PATHS), true, `${f} should force the API half`);
    assert.equal(halfChanged([f], WEB_PATHS), true, `${f} should force the web half`);
  }
});

test('the globs are anchored — a nested lookalike path does not trigger a half', () => {
  assert.equal(halfChanged(['docs/packages/web/notes.md'], WEB_PATHS), false);
  assert.equal(halfChanged(['plugins/supabase/functions/x.ts'], API_PATHS), false);
});

test('pickBaseline prefers the deployed marker when it is an ancestor of HEAD', () => {
  assert.deepEqual(pickBaseline({ tagSha: 'dead', tagIsAncestor: true, pushBase: 'beef' }), {
    base: 'dead',
    source: 'deployed',
  });
});

test('pickBaseline falls back to the push baseline when the marker is missing', () => {
  // A fork that has never deployed, an unfetched tag, or the very first run
  // after this lands. Falling back reproduces the previous behaviour; falling
  // through to "nothing changed" would reintroduce the incident.
  assert.deepEqual(pickBaseline({ tagSha: null, tagIsAncestor: false, pushBase: 'beef' }), {
    base: 'beef',
    source: 'push',
  });
});

test('pickBaseline falls back when the marker is not an ancestor of HEAD', () => {
  // A revert, or a re-run of an older ref: diffing against a marker ahead of
  // HEAD reports the marker-only files as changed here, which is true of the
  // diff and misleading about the merge.
  const picked = pickBaseline({ tagSha: 'ahead', tagIsAncestor: false, pushBase: 'beef' });
  assert.equal(picked.base, 'beef');
  assert.match(picked.source, /not an ancestor/);
});

test('pickBaseline never resolves doubt to "nothing changed" when there is no push baseline', () => {
  // A root commit, or a checkout whose parent is not present: `HEAD~1` fails.
  // Falling back to HEAD would make `git diff HEAD HEAD` empty and BOTH halves
  // false — the one doubt path that answers "this half has no changes", which is
  // the answer the incident was made of. `base: null` means "every tracked file".
  for (const tag of [
    { tagSha: null, tagIsAncestor: false },
    { tagSha: 'ahead', tagIsAncestor: false },
  ]) {
    const picked = pickBaseline({ ...tag, pushBase: null });
    assert.equal(picked.base, null, 'no baseline must not degrade to a HEAD..HEAD diff');
    assert.match(picked.source, /every tracked file/);
  }
});

test('pickBaseline still prefers a usable marker when the push baseline is missing', () => {
  assert.deepEqual(pickBaseline({ tagSha: 'dead', tagIsAncestor: true, pushBase: null }), {
    base: 'dead',
    source: 'deployed',
  });
});

test('a manual deploy_target overrides detection, and auto/empty defers to it', () => {
  assert.deepEqual(resolveManualTarget('all'), { api: true, web: true });
  assert.deepEqual(resolveManualTarget('api'), { api: true, web: false });
  assert.deepEqual(resolveManualTarget('web'), { api: false, web: true });
  assert.equal(resolveManualTarget('auto'), null);
  assert.equal(resolveManualTarget(''), null);
  assert.equal(resolveManualTarget(undefined), null);
});
