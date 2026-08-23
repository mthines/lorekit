#!/usr/bin/env node
// Unit tests for the pure argument parser of the embedding backfill. Runs with
// the built-in runner (`node --test`), no dependencies. The parser decides what
// a PAID run touches and how much it spends — a flag that silently falls back
// is money or coverage lost with no error — so it is exactly the logic a test
// should pin. Importing the module must NOT start a backfill: the
// `invokedDirectly` seam ensures that (argv[1] ends in `.test.mjs`, not
// `backfill-embeddings.mjs`).
//
// NOTE ON THE NODE FLOOR: the script imports the repo's pure embedding module,
// which is TypeScript executed directly by Node's type stripping, so this file
// needs Node >= 22.18 — the same floor the script itself documents and asserts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './backfill-embeddings.mjs';

/** The parser's shape for a run with no flags — the baseline every case diffs against. */
const DEFAULTS = { dryRun: false, limit: null, batchSize: 96, scope: null, sleepMs: 0, error: null };

test('no arguments — every default, no error', () => {
  assert.deepEqual(parseArgs([]), DEFAULTS);
});

test('--dry-run is a boolean and consumes no value', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { ...DEFAULTS, dryRun: true });
  // It must not swallow the flag after it.
  assert.deepEqual(parseArgs(['--dry-run', '--scope', 'personal']), {
    ...DEFAULTS, dryRun: true, scope: 'personal',
  });
});

test('well-formed values parse, including the boundary ones', () => {
  assert.equal(parseArgs(['--limit', '1']).limit, 1);
  assert.equal(parseArgs(['--limit', '500']).limit, 500);
  assert.equal(parseArgs(['--scope', 'repo::mthines/lorekit']).scope, 'repo::mthines/lorekit');
  assert.equal(parseArgs(['--batch-size', '12']).batchSize, 12);
  // `--sleep-ms 0` is a legitimate request for no pause and must NOT be
  // mistaken for the malformed case, whose fallback is also 0.
  assert.equal(parseArgs(['--sleep-ms', '0']).sleepMs, 0);
  assert.equal(parseArgs(['--sleep-ms', '250']).sleepMs, 250);
});

test('--batch-size is capped, never raised, by the provider maximum', () => {
  assert.equal(parseArgs(['--batch-size', '5000']).batchSize, 96);
  assert.equal(parseArgs(['--batch-size', '96']).batchSize, 96);
});

test('a fractional value is floored rather than rejected', () => {
  assert.equal(parseArgs(['--limit', '10.9']).limit, 10);
  assert.equal(parseArgs(['--sleep-ms', '2.5']).sleepMs, 2);
});

test('a MALFORMED numeric value is a usage error on every flag, never a default', () => {
  // The regression this file exists for: `--sleep-ms abc` used to become 0,
  // deleting the rate-limit relief on the one flag whose purpose is slowing a
  // paid run, and `--batch-size abc` used to become the 96-row cap.
  for (const [flag, value] of [
    ['--limit', 'abc'], ['--limit', '0'], ['--limit', '-1'],
    ['--batch-size', 'abc'], ['--batch-size', '0'], ['--batch-size', '-5'],
    ['--sleep-ms', 'abc'], ['--sleep-ms', '-1'],
  ]) {
    const args = parseArgs([flag, value]);
    assert.match(args.error ?? '', new RegExp(`^\\${flag} needs `), `${flag} ${value} must be a usage error`);
    assert.match(args.error, new RegExp(`"${value}"`), `${flag} ${value} must quote the value it rejected`);
  }
});

test('a MISSING value is a usage error, and a flag-shaped one is never eaten', () => {
  for (const flag of ['--limit', '--scope', '--batch-size', '--sleep-ms']) {
    assert.match(parseArgs([flag]).error ?? '', new RegExp(`^\\${flag} needs `), `${flag} alone`);
    assert.match(parseArgs([flag, '   ']).error ?? '', new RegExp(`^\\${flag} needs `), `${flag} blank`);
    // The swallowing case: the value-taking flag must not consume the NEXT flag.
    const args = parseArgs([flag, '--scope', 'personal']);
    assert.match(args.error ?? '', new RegExp(`^\\${flag} needs `), `${flag} must not swallow --scope`);
  }
});

test('--limit says WHY it refuses rather than defaulting', () => {
  // Its absence means "no limit", so a bad value must never widen the run.
  assert.match(parseArgs(['--limit', '0']).error, /bounds what a run spends/);
  assert.equal(parseArgs(['--limit', '0']).limit, null);
});

test('--scope refuses a missing value instead of widening to every scope', () => {
  assert.match(parseArgs(['--scope']).error, /every scope/);
  assert.equal(parseArgs(['--scope']).scope, null);
});

test('an unrecognised argument is a usage error that lists the accepted flags', () => {
  // A typo used to fall through silently: `--scpoe personal` ran every scope
  // and `--dry-runn` billed a real run.
  for (const bad of ['--scpoe', '--dry-runn', '-limit', 'limit', '']) {
    const args = parseArgs([bad, 'personal']);
    assert.match(args.error ?? '', /^unknown argument/, `${JSON.stringify(bad)} must be rejected`);
    assert.match(args.error, /--dry-run/, 'the error must list the accepted flags');
  }
});

test('the FIRST error wins and parsing stops there', () => {
  const args = parseArgs(['--sleep-ms', 'abc', '--limit', 'also-bad']);
  assert.match(args.error, /^--sleep-ms needs /);
});

test('flags compose in any order', () => {
  assert.deepEqual(parseArgs(['--sleep-ms', '100', '--dry-run', '--scope', 'global', '--limit', '7']), {
    dryRun: true, limit: 7, batchSize: 96, scope: 'global', sleepMs: 100, error: null,
  });
});
