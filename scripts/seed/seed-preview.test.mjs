import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, resolveChannel, buildStatements, PRODUCTION_PROJECT_REF } from './seed-preview.mjs';
import { buildDataset } from './preview-dataset.mjs';

test('parseArgs reads flags and defaults days to 30', () => {
  const opts = parseArgs(['--target', 'preview', '--user-email', 'a@b.com', '--reset', '--dry-run']);
  assert.equal(opts.userEmail, 'a@b.com');
  assert.equal(opts.reset, true);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.days, 30);
});

test('parseArgs reads --days as an integer', () => {
  const opts = parseArgs(['--user-email', 'a@b.com', '--days', '14']);
  assert.equal(opts.days, 14);
});

test('resolveChannel refuses the production project ref UNCONDITIONALLY — no flag can override it', () => {
  const result = resolveChannel(
    { psqlUrl: null, projectRef: PRODUCTION_PROJECT_REF, userEmail: 'a@b.com' },
    { SUPABASE_ACCESS_TOKEN: 'token' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /production/i);
});

test('resolveChannel refuses the production ref even when it comes from the environment, not a flag', () => {
  const result = resolveChannel(
    { psqlUrl: null, projectRef: null },
    { SUPABASE_PROJECT_REF: PRODUCTION_PROJECT_REF, SUPABASE_ACCESS_TOKEN: 'token' },
  );
  assert.equal(result.ok, false);
});

test('resolveChannel accepts a non-production ref with an access token', () => {
  const result = resolveChannel(
    { psqlUrl: null, projectRef: 'some-preview-ref' },
    { SUPABASE_ACCESS_TOKEN: 'token' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'api');
});

test('resolveChannel requires an access token for the API channel', () => {
  const result = resolveChannel({ psqlUrl: null, projectRef: 'some-preview-ref' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /SUPABASE_ACCESS_TOKEN/);
});

test('resolveChannel skips the access-token requirement on a dry run — it never touches the network', () => {
  const result = resolveChannel({ psqlUrl: null, projectRef: 'some-preview-ref', dryRun: true }, {});
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'api');
});

test('resolveChannel prefers an explicit --psql url over any project ref, and never checks it for production', () => {
  const result = resolveChannel({ psqlUrl: 'postgresql://localhost/x', projectRef: PRODUCTION_PROJECT_REF }, {});
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'psql');
});

test('resolveChannel demands SOME target — no implicit default', () => {
  const result = resolveChannel({ psqlUrl: null, projectRef: null }, {});
  assert.equal(result.ok, false);
});

test('buildStatements runs reset (when requested) before org, org before memories, and memories before its detail tables', () => {
  const dataset = buildDataset({ now: new Date('2026-09-10T12:00:00.000Z') });
  const withReset = buildStatements({ dataset, userId: 'u1', reset: true }).map((s) => s.name);
  assert.deepEqual(withReset, ['reset', 'org', 'memories', 'read_daily', 'citations', 'usage_events']);

  const withoutReset = buildStatements({ dataset, userId: 'u1', reset: false }).map((s) => s.name);
  assert.deepEqual(withoutReset, ['org', 'memories', 'read_daily', 'citations', 'usage_events']);
});
