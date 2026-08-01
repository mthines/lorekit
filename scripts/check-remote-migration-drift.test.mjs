#!/usr/bin/env node
// Unit tests for the pure core of the remote-migration-drift classifier. Runs
// with the built-in runner (`node --test`), no dependencies — same shape as
// check-migration-order.test.mjs. This logic decides whether a deploy pushes,
// skips, or stops, so a regression here is exactly what a test must catch.
// Importing the module must NOT consume stdin — the `invokedDirectly` seam
// ensures that (argv[1] ends in `.test.mjs`, not the script's own name).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMigrationList, classifyDrift, annotate } from './check-remote-migration-drift.mjs';

// Verbatim shape of `supabase migration list --linked` when a `/preview` run on
// an open PR has pushed 00049–00051 to the shared preview project and `main`
// (00001–00048, abbreviated here) has nothing pending. This is the exact state
// that wedged the Deploy workflow.
const PREVIEW_AHEAD = `
Connecting to remote database...

        Local      | Remote     | Time (UTC)
    ---------------|------------|---------------------
     00046         | 00046      |
     00047         | 00047      |
     00048         | 00048      |
                   | 00049      |
                   | 00050      |
                   | 00051      |
`;

test('parseMigrationList — reads both columns and ignores chatter, header, separator', () => {
  const { local, remote } = parseMigrationList(PREVIEW_AHEAD);
  assert.deepEqual(local, ['00046', '00047', '00048']);
  assert.deepEqual(remote, ['00046', '00047', '00048', '00049', '00050', '00051']);
});

test('parseMigrationList — strips ANSI colour escapes around the version cells', () => {
  const coloured = ' \u001B[32m00048\u001B[0m | \u001B[32m00048\u001B[0m | \n';
  assert.deepEqual(parseMigrationList(coloured), { local: ['00048'], remote: ['00048'] });
});

test('parseMigrationList — empty / undefined input yields empty columns', () => {
  assert.deepEqual(parseMigrationList(''), { local: [], remote: [] });
  assert.deepEqual(parseMigrationList(undefined), { local: [], remote: [] });
});

// ── The regression this whole change exists for ──────────────────────────────
test('classifyDrift — remote AHEAD with nothing pending locally is SKIP, not a failure', () => {
  const result = classifyDrift(parseMigrationList(PREVIEW_AHEAD));
  assert.equal(result.action, 'skip');
  assert.deepEqual(result.remoteOnly, ['00049', '00050', '00051']);
  assert.deepEqual(result.localPending, []);
});

test('classifyDrift — remote in sync is PUSH (nothing pending)', () => {
  const result = classifyDrift({ local: ['00047', '00048'], remote: ['00047', '00048'] });
  assert.equal(result.action, 'push');
  assert.deepEqual(result.localPending, []);
  assert.deepEqual(result.remoteOnly, []);
});

test('classifyDrift — remote BEHIND is PUSH, and names the pending versions', () => {
  const result = classifyDrift({ local: ['00047', '00048'], remote: ['00047'] });
  assert.equal(result.action, 'push');
  assert.deepEqual(result.localPending, ['00048']);
  assert.deepEqual(result.remoteOnly, []);
});

test('classifyDrift — AHEAD *and* pending is FAIL (ambiguous, a human decides)', () => {
  const result = classifyDrift({ local: ['00047', '00048'], remote: ['00047', '00049'] });
  assert.equal(result.action, 'fail');
  assert.deepEqual(result.localPending, ['00048']);
  assert.deepEqual(result.remoteOnly, ['00049']);
});

test('classifyDrift — an unparseable listing never SKIPs; it falls back to PUSH', () => {
  // No local column parsed (CLI error, format change) but a remote-only version
  // present: skipping on that guess could silently drop a real migration, so the
  // classifier restores the previous behaviour and lets `db push` speak.
  assert.equal(classifyDrift({ local: [], remote: ['00049'] }).action, 'push');
  assert.equal(classifyDrift({}).action, 'push');
});

test('classifyDrift — a fresh remote (no history) is PUSH with everything pending', () => {
  const result = classifyDrift({ local: ['00001', '00002'], remote: [] });
  assert.equal(result.action, 'push');
  assert.deepEqual(result.localPending, ['00001', '00002']);
});

test('annotate — skip warns and names the drifted versions; fail errors and names both sides', () => {
  const skip = annotate(classifyDrift(parseMigrationList(PREVIEW_AHEAD)));
  assert.match(skip, /^::warning::/);
  assert.match(skip, /00049, 00050, 00051/);
  assert.match(skip, /nothing was repaired/i);

  const fail = annotate(classifyDrift({ local: ['00048'], remote: ['00049'] }));
  assert.match(fail, /^::error::/);
  assert.match(fail, /00049/);
  assert.match(fail, /00048/);

  const push = annotate(classifyDrift({ local: ['00048'], remote: [] }));
  assert.doesNotMatch(push, /^::(warning|error)::/);
});
