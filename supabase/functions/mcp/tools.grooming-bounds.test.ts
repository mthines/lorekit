/**
 * Regression test for `assertGroomConditionsInBounds` — the MCP-side bounds
 * check for `toolPolicyCreate`/`toolPolicyUpdate` that mirrors the REST
 * path's zod schema (`PolicyCreateBodySchema`/`PolicyUpdateBodySchema`,
 * `GroomConditionsSchema`: min_age_days/unseen_days 1-3650, and the three
 * counters max_seen_count/max_read_count/max_opened_count 0-100000). Before this check existed, an out-of-range value reached the
 * `lorekit_policy_create`/`lorekit_policy_update` RPC unvalidated and
 * surfaced as a raw Postgres CHECK-constraint error instead of a clean
 * `UserInputError` — see the review thread this closes.
 *
 * Run with: deno test --no-check supabase/functions/mcp/tools.grooming-bounds.test.ts
 * (--no-check because the surrounding tree needs the full Supabase import-map
 * to typecheck; `node scripts/ci/deno-check-functions.mjs` is the typecheck gate).
 */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { UserInputError } from '../_shared/scope/scope.ts';
import { assertGroomConditionsInBounds } from './tools.ts';

Deno.test('assertGroomConditionsInBounds accepts an empty/undefined/null conditions set', () => {
  assertGroomConditionsInBounds({});
  assertGroomConditionsInBounds({
    min_age_days: null,
    unseen_days: null,
    max_seen_count: null,
    max_read_count: null,
    max_opened_count: null,
  });
});

Deno.test('assertGroomConditionsInBounds accepts values at the boundary', () => {
  assertGroomConditionsInBounds({
    min_age_days: 1,
    unseen_days: 3650,
    max_seen_count: 0,
    max_read_count: 0,
    max_opened_count: 0,
  });
  assertGroomConditionsInBounds({
    min_age_days: 3650,
    unseen_days: 1,
    max_seen_count: 100_000,
    max_read_count: 100_000,
    max_opened_count: 100_000,
  });
});

Deno.test('assertGroomConditionsInBounds rejects min_age_days outside 1-3650', () => {
  assertThrows(() => assertGroomConditionsInBounds({ min_age_days: 0 }), UserInputError);
  assertThrows(() => assertGroomConditionsInBounds({ min_age_days: 3651 }), UserInputError);
});

Deno.test('assertGroomConditionsInBounds rejects unseen_days outside 1-3650', () => {
  assertThrows(() => assertGroomConditionsInBounds({ unseen_days: 0 }), UserInputError);
  assertThrows(() => assertGroomConditionsInBounds({ unseen_days: 3651 }), UserInputError);
});

Deno.test('assertGroomConditionsInBounds rejects max_seen_count outside 0-100000', () => {
  assertThrows(() => assertGroomConditionsInBounds({ max_seen_count: -1 }), UserInputError);
  assertThrows(() => assertGroomConditionsInBounds({ max_seen_count: 100_001 }), UserInputError);
});

Deno.test('assertGroomConditionsInBounds rejects max_read_count outside 0-100000', () => {
  assertThrows(() => assertGroomConditionsInBounds({ max_read_count: -1 }), UserInputError);
  assertThrows(() => assertGroomConditionsInBounds({ max_read_count: 100_001 }), UserInputError);
});

Deno.test('assertGroomConditionsInBounds rejects max_opened_count outside 0-100000', () => {
  assertThrows(() => assertGroomConditionsInBounds({ max_opened_count: -1 }), UserInputError);
  assertThrows(() => assertGroomConditionsInBounds({ max_opened_count: 100_001 }), UserInputError);
});

// The three counters share a range but not a field: a check that only ever
// looked at max_seen_count would pass every case above and still let an
// out-of-range max_read_count or max_opened_count reach the RPC.
Deno.test('assertGroomConditionsInBounds error message names the offending field', () => {
  const err = assertThrows(() => assertGroomConditionsInBounds({ max_seen_count: -5 }), UserInputError);
  assertEquals(err.message, 'max_seen_count must be between 0 and 100000');

  const readErr = assertThrows(() => assertGroomConditionsInBounds({ max_read_count: -5 }), UserInputError);
  assertEquals(readErr.message, 'max_read_count must be between 0 and 100000');

  const openedErr = assertThrows(() => assertGroomConditionsInBounds({ max_opened_count: -5 }), UserInputError);
  assertEquals(openedErr.message, 'max_opened_count must be between 0 and 100000');
});
