// `projectBatchResult` — how `lorekit show <a::b> <c::d> …` maps a store's
// `readMany` answer back onto the refs the user typed.
//
// Pure, so it is tested by direct import with no store and no mock REST server
// (CLAUDE.md: the loopback-HTTP CLI tests are the pre-existing flaky set; a
// batch read's projection needs neither a socket nor a disk).
//
// The case that matters is the THIRD outcome. `entries` and `missing` are the
// two the response documents; a ref in neither is one the store silently
// dropped — past `MEMORY_CITED_MAX` (32), or a scope the server's grammar
// rejects — and calling that "not found" asserts something no store said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectBatchResult, REF_DROPPED_ERROR } from '../src/commands/show.mjs';

const ref = (scope, key) => ({ scope, key });
const row = (scope, key) => ({ scope, key, value: 'v', updated_at: '2026-07-20T10:00:00.000Z' });

test('a found ref carries its record', () => {
  const [slot] = projectBatchResult([ref('global', 'a')], { entries: [row('global', 'a')], missing: [] });
  assert.equal(slot.found, true);
  assert.equal(slot.error, null);
  assert.equal(slot.record.key, 'a');
});

test('a ref named in `missing` is a real not-found — no error', () => {
  const [slot] = projectBatchResult([ref('global', 'a')], { entries: [], missing: ['global::a'] });
  assert.equal(slot.found, false);
  assert.equal(slot.record, null);
  // No error: the store looked and said no. This is the outcome the renderer
  // prints "no such key in this store" for, and it is accurate.
  assert.equal(slot.error, null);
});

test('a ref in NEITHER list is reported as dropped, not as not-found', () => {
  const [slot] = projectBatchResult([ref('global', 'a')], { entries: [], missing: [] });
  assert.equal(slot.found, false);
  assert.equal(slot.error, REF_DROPPED_ERROR);
});

test('the 33rd ref of an over-cap batch is dropped, not not-found', () => {
  // What the remote store actually returns for a 40-ref request: it answers the
  // first 32 (`parseMemoryRefs` truncates there) and says nothing about the
  // rest — they reach neither `entries` nor `missing`.
  const refs = Array.from({ length: 40 }, (_, i) => ref('global', `k${i}`));
  const slots = projectBatchResult(refs, {
    entries: refs.slice(0, 32).map((r) => row(r.scope, r.key)),
    missing: [],
  });
  assert.equal(slots.length, 40);
  assert.ok(slots.slice(0, 32).every((s) => s.found === true));
  const tail = slots.slice(32);
  assert.equal(tail.length, 8);
  assert.ok(tail.every((s) => s.found === false && s.error === REF_DROPPED_ERROR),
    'every ref past the cap must say the store never looked, not that the lesson is absent');
});

test('order follows the request, not the response', () => {
  const refs = [ref('global', 'a'), ref('repo::acme/app', 'b'), ref('global', 'c')];
  const slots = projectBatchResult(refs, {
    // Deliberately reversed relative to the request.
    entries: [row('global', 'c'), row('global', 'a')],
    missing: ['repo::acme/app::b'],
  });
  assert.deepEqual(slots.map((s) => (s.record ? s.record.key : null)), ['a', null, 'c']);
});

test('scope matching is verbatim — a case difference is a different address', () => {
  // Same rule `parseMemoryRefs` follows: the server resolves a ref by verbatim
  // comparison, so `Global::a` is not `global::a`. Folding here would claim a
  // hit the store never returned.
  const [slot] = projectBatchResult([ref('Global', 'a')], { entries: [row('global', 'a')], missing: [] });
  assert.equal(slot.found, false);
});

test('an absent `missing` field does not crash the projection', () => {
  // Totality, matching every other batch-read helper in this change.
  const slots = projectBatchResult([ref('global', 'a')], { entries: [row('global', 'a')] });
  assert.equal(slots[0].found, true);
});
