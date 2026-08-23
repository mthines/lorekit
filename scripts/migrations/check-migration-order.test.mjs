#!/usr/bin/env node
// Unit tests for the pure core of the migration-order guard. Runs with the
// built-in runner (`node --test`), no dependencies. The guard gates deploys, so
// a regression in this logic is exactly what a test should catch. Importing the
// module must NOT run its git plumbing — the `invokedDirectly` seam ensures that
// (argv[1] ends in `.test.mjs`, not `check-migration-order.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prefixOf, maxPrefix, misordered } from './check-migration-order.mjs';

test('prefixOf — parses the numeric on-disk prefix, else null', () => {
  assert.equal(prefixOf('supabase/migrations/00041_org_actor_override.sql'), 41);
  assert.equal(prefixOf('00042_audit.sql'), 42); // bare filename
  assert.equal(prefixOf('supabase/migrations/00001_memories.sql'), 1); // no octal footgun
  assert.equal(prefixOf('supabase/migrations/README.md'), null); // not a .sql
  assert.equal(prefixOf('supabase/migrations/no_number.sql'), null); // no numeric prefix
});

test('maxPrefix — highest number, or -1 when there are none', () => {
  assert.equal(maxPrefix(['supabase/migrations/00039_a.sql', 'supabase/migrations/00042_b.sql']), 42);
  assert.equal(maxPrefix(['supabase/migrations/00042_b.sql', 'supabase/migrations/00039_a.sql']), 42); // order-independent
  assert.equal(maxPrefix([]), -1);
  assert.equal(maxPrefix(['supabase/migrations/README.md']), -1); // no migrations
});

test('misordered — rejects <= base max (incl. duplicates), allows strictly greater', () => {
  const at = (nums) => nums.map((n) => `supabase/migrations/000${n}_x.sql`);
  assert.deepEqual(misordered(at([43]), 42), []); // strictly greater is fine
  assert.deepEqual(misordered(at([41]), 42).map((e) => e.num), [41]); // lower is rejected
  assert.deepEqual(misordered(at([42]), 42).map((e) => e.num), [42]); // EQUAL is rejected (collision)
  assert.deepEqual(misordered(at([42, 40]), 42).map((e) => e.num), [40, 42]); // multiple, returned sorted
  assert.deepEqual(misordered([], 42), []); // nothing added
});

test('misordered — a fresh base (no prior migrations) accepts any addition', () => {
  assert.deepEqual(misordered(['supabase/migrations/00001_first.sql'], -1), []);
});
