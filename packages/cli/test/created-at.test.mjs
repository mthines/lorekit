// Tests for the optional created_at override on memory.write (migration support):
// the pure normalizeCreatedAt validator and its wiring into the local file store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCreatedAt, CLOCK_SKEW_MS } from '../src/store/created-at.mjs';
import { createLocalStore } from '../src/store/local.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-created-'));
}

const NOW = new Date('2026-07-25T12:00:00.000Z');

test('normalizeCreatedAt returns null when absent', () => {
  assert.equal(normalizeCreatedAt(undefined, NOW), null);
  assert.equal(normalizeCreatedAt(null, NOW), null);
});

test('normalizeCreatedAt normalises a valid past timestamp', () => {
  assert.equal(normalizeCreatedAt('2021-03-04T05:06:07Z', NOW), '2021-03-04T05:06:07.000Z');
  assert.equal(normalizeCreatedAt('2020-01-01', NOW), '2020-01-01T00:00:00.000Z');
});

test('normalizeCreatedAt rejects invalid, empty, non-string, and future values', () => {
  assert.throws(() => normalizeCreatedAt('not-a-date', NOW), /valid date-time/);
  assert.throws(() => normalizeCreatedAt('', NOW), /ISO 8601/);
  assert.throws(() => normalizeCreatedAt(12345, NOW), /ISO 8601/);
  const future = new Date(NOW.getTime() + CLOCK_SKEW_MS + 60_000).toISOString();
  assert.throws(() => normalizeCreatedAt(future, NOW), /future/);
});

test('LocalStore.write applies created_at to a new entry (created and updated)', async () => {
  const store = createLocalStore(tmpDir());
  const res = await store.write({
    scope: 'global',
    key: 'migrated-lesson',
    value: 'imported body',
    created_at: '2020-06-15T08:30:00Z',
  });
  assert.equal(res.ok, true);
  assert.equal(res.entry.created, '2020-06-15T08:30:00.000Z');
  assert.equal(res.entry.updated, '2020-06-15T08:30:00.000Z');
});

test('LocalStore.write defaults created/updated to now when created_at omitted', async () => {
  const store = createLocalStore(tmpDir());
  const before = Date.now();
  const res = await store.write({ scope: 'global', key: 'k', value: 'v' });
  assert.equal(res.ok, true);
  assert.ok(new Date(res.entry.created).getTime() >= before);
});

test('LocalStore.write ignores created_at for an existing key (creation date never moves)', async () => {
  const store = createLocalStore(tmpDir());
  await store.write({ scope: 'global', key: 'k', value: 'v1', created_at: '2020-01-01T00:00:00Z' });
  const res = await store.write({ scope: 'global', key: 'k', value: 'v2', created_at: '2019-01-01T00:00:00Z' });
  assert.equal(res.ok, true);
  // created stays anchored to the first write's override, not the second.
  assert.equal(res.entry.created, '2020-01-01T00:00:00.000Z');
  assert.equal(res.entry.value, 'v2');
});

test('LocalStore.write returns ok:false on an invalid created_at', async () => {
  const store = createLocalStore(tmpDir());
  const res = await store.write({ scope: 'global', key: 'k', value: 'v', created_at: 'garbage' });
  assert.equal(res.ok, false);
  assert.match(res.error, /valid date-time/);
});
