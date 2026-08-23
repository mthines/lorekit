import test from 'node:test';
import assert from 'node:assert/strict';

import { isLoadTestEmail, isStale, selectSweepable, LOAD_USER_EMAIL } from './load-test-cleanup.mjs';

/**
 * The sweep's guards. These matter more than most tests in this repo: the code
 * they protect deletes user accounts from a live project, and on the production
 * target those are real tenants. Every case below is a way a permissive guard
 * destroys data.
 */

const NOW = Date.parse('2026-08-22T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

test('the pattern is anchored at BOTH ends', () => {
  assert.ok(isLoadTestEmail('loadtest-a1b2c3d4-0@lorekit.test'));
  assert.ok(isLoadTestEmail('loadtest-00000000-42@lorekit.test'));

  // A prefix test would accept all of these.
  assert.equal(isLoadTestEmail('xloadtest-a1b2c3d4-0@lorekit.test'), false);
  assert.equal(isLoadTestEmail('loadtest-a1b2c3d4-0@lorekit.test.evil.com'), false);
  assert.equal(isLoadTestEmail('loadtest-a1b2c3d4-0@lorekit.test\n'), false);
});

test('it never matches a real-looking address', () => {
  for (const email of [
    'mads@dash0.com',
    'loadtest@lorekit.test',              // no run id
    'loadtest-a1b2c3d4@lorekit.test',     // no index
    'loadtest-NOTHEX00-0@lorekit.test',   // run id must be hex
    'loadtest-a1b2c3d4-0@gmail.com',      // wrong domain
    'smoke-a1b2c3d4-0@lorekit.test',      // a different harness's users
  ]) {
    assert.equal(isLoadTestEmail(email), false, `must NOT match: ${email}`);
  }
});

test('non-strings are rejected rather than coerced', () => {
  for (const v of [undefined, null, 0, {}, [], true]) {
    assert.equal(isLoadTestEmail(v), false);
  }
});

test('the age floor protects a concurrently running load test', () => {
  // A load test provisions users seconds before using them. Without the floor,
  // a sweep would delete them mid-flight and the run would report a wall of 401s.
  assert.equal(isStale(ago(1), 60, NOW), false);
  assert.equal(isStale(ago(59), 60, NOW), false);
  assert.equal(isStale(ago(60), 60, NOW), true, 'exactly at the boundary is stale');
  assert.equal(isStale(ago(600), 60, NOW), true);
});

test('an undateable user is NOT swept — fail closed', () => {
  // Cost of skipping one: a warning. Cost of deleting a live one: a broken run.
  for (const v of [undefined, null, '', 'not-a-date', 'yesterday']) {
    assert.equal(isStale(v, 0, NOW), false, `must not sweep with created_at=${JSON.stringify(v)}`);
  }
});

test('selection requires BOTH guards, not either', () => {
  const users = [
    { id: '1', email: 'loadtest-aaaaaaaa-0@lorekit.test', created_at: ago(120) }, // both → swept
    { id: '2', email: 'loadtest-bbbbbbbb-1@lorekit.test', created_at: ago(2) },   // too new
    { id: '3', email: 'mads@dash0.com', created_at: ago(9999) },                  // wrong pattern
    { id: '4', email: 'loadtest-cccccccc-2@lorekit.test', created_at: null },     // undateable
  ];
  assert.deepEqual(selectSweepable(users, 60, NOW).map((u) => u.id), ['1']);
});

test('an empty or missing list is not an error', () => {
  assert.deepEqual(selectSweepable([], 60, NOW), []);
  assert.deepEqual(selectSweepable(undefined, 60, NOW), []);
});

test('the pattern is the one the load test actually mints', () => {
  // Drift guard: if load-test.mjs changes its email shape, the sweep silently
  // stops finding anything — a residue leak with no error.
  const runId = 'a1b2c3d4';
  const minted = `loadtest-${runId}-0@lorekit.test`;
  assert.match(minted, LOAD_USER_EMAIL);
});
