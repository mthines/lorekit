// Tests for the local file store's TTL / expiry parity with the hosted store:
// the pure ttl.mjs helpers and their wiring into LocalStore (write, read, list,
// listScopes, putEntry). Before this, `--ttl-days` was silently dropped on a
// local write and local reads never expired anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTtlDays, expiresAtFrom, isExpired, TTL_MAX_DAYS } from '../src/store/ttl.mjs';
import { createLocalStore } from '../src/store/local.mjs';
import { parseEntry } from '../src/store/format.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-ttl-'));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── pure helpers ────────────────────────────────────────────────────────────

test('parseTtlDays returns null when absent', () => {
  assert.equal(parseTtlDays(undefined), null);
  assert.equal(parseTtlDays(null), null);
});

test('parseTtlDays accepts valid integers and numeric strings', () => {
  assert.equal(parseTtlDays(1), 1);
  assert.equal(parseTtlDays(30), 30);
  assert.equal(parseTtlDays('30'), 30);
  assert.equal(parseTtlDays(TTL_MAX_DAYS), TTL_MAX_DAYS);
});

test('parseTtlDays rejects zero, fractional, out-of-range, and non-finite', () => {
  assert.throws(() => parseTtlDays(0), />= 1/);
  assert.throws(() => parseTtlDays(1.5), /integer/);
  assert.throws(() => parseTtlDays(366), /<= 365/);
  assert.throws(() => parseTtlDays('nope'), /finite/);
  assert.throws(() => parseTtlDays(Infinity), /finite/);
});

test('expiresAtFrom advances a base instant by whole days', () => {
  const base = '2026-01-01T00:00:00.000Z';
  assert.equal(expiresAtFrom(1, base), '2026-01-02T00:00:00.000Z');
  assert.equal(expiresAtFrom(30, new Date(base)), '2026-01-31T00:00:00.000Z');
});

test('isExpired: absent never expires; unparseable fails safe; past expires', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  assert.equal(isExpired(null, now), false);
  assert.equal(isExpired(undefined, now), false);
  assert.equal(isExpired('garbage', now), false); // fail-safe: never hide on corruption
  assert.equal(isExpired('2026-05-31T23:59:59.000Z', now), true);
  assert.equal(isExpired('2026-06-02T00:00:00.000Z', now), false);
});

// ── LocalStore wiring ───────────────────────────────────────────────────────

test('LocalStore.write sets expires_at ~ now + ttl_days on the on-disk row', async () => {
  const dir = tmpDir();
  const store = createLocalStore(dir);
  const before = Date.now();
  const res = await store.write({ scope: 'global', key: 'transient', value: 'v', ttl_days: 30 });
  assert.equal(res.ok, true);
  const expMs = Date.parse(res.entry.expires_at);
  assert.ok(Math.abs(expMs - (before + 30 * DAY_MS)) < 5000, 'expiry ≈ now + 30d');

  // Persisted to frontmatter, not just returned.
  const files = fs.readdirSync(path.join(dir, 'global'));
  const onDisk = parseEntry(fs.readFileSync(path.join(dir, 'global', files[0]), 'utf8'));
  assert.equal(onDisk.expires_at, res.entry.expires_at);
});

test('LocalStore.write without ttl_days leaves expires_at null (permanent)', async () => {
  const store = createLocalStore(tmpDir());
  const res = await store.write({ scope: 'global', key: 'k', value: 'v' });
  assert.equal(res.entry.expires_at, null);
});

test('LocalStore hides an expired entry from read and list', async () => {
  const store = createLocalStore(tmpDir());
  // Write, then force the entry expired by rewriting its frontmatter in the past.
  await store.write({ scope: 'global', key: 'gone', value: 'v', ttl_days: 1 });
  const expired = await store.write({ scope: 'global', key: 'live', value: 'v', ttl_days: 1 });
  assert.ok(expired.entry.expires_at);

  // Backdate the first entry's expiry via putEntry (verbatim upsert).
  await store.putEntry({
    scope: 'global', key: 'gone', value: 'v',
    expires_at: '2000-01-01T00:00:00.000Z',
  });

  const read = await store.read({ scope: 'global', key: 'gone' });
  assert.equal(read.entry, null, 'expired entry is not readable');

  const list = await store.list({ scope: 'global' });
  const keys = list.entries.map((e) => e.key);
  assert.ok(!keys.includes('gone'), 'expired entry absent from list');
  assert.ok(keys.includes('live'), 'unexpired entry still listed');
});

test('LocalStore clear_ttl removes an existing expiry on update', async () => {
  const store = createLocalStore(tmpDir());
  const set = await store.write({ scope: 'global', key: 'k', value: 'v1', ttl_days: 10 });
  assert.ok(set.entry.expires_at);
  const cleared = await store.write({ scope: 'global', key: 'k', value: 'v2', clear_ttl: true });
  assert.equal(cleared.entry.expires_at, null);
  assert.equal(cleared.entry.value, 'v2');
});

test('LocalStore clear_ttl beats ttl_days when both are supplied', async () => {
  const store = createLocalStore(tmpDir());
  const res = await store.write({
    scope: 'global', key: 'k', value: 'v', ttl_days: 30, clear_ttl: true,
  });
  assert.equal(res.entry.expires_at, null);
});

test('LocalStore update without ttl keeps the existing expiry', async () => {
  const store = createLocalStore(tmpDir());
  const set = await store.write({ scope: 'global', key: 'k', value: 'v1', ttl_days: 10 });
  const kept = await store.write({ scope: 'global', key: 'k', value: 'v2' });
  assert.equal(kept.entry.expires_at, set.entry.expires_at);
});

test('LocalStore.write returns ok:false on an invalid ttl_days', async () => {
  const store = createLocalStore(tmpDir());
  const res = await store.write({ scope: 'global', key: 'k', value: 'v', ttl_days: 999 });
  assert.equal(res.ok, false);
  assert.match(res.error, /<= 365/);
});

test('putEntry preserves expires_at verbatim (lossless migrate primitive)', async () => {
  const store = createLocalStore(tmpDir());
  const exp = '2030-01-01T00:00:00.000Z';
  const res = await store.putEntry({ scope: 'global', key: 'k', value: 'v', expires_at: exp });
  assert.equal(res.entry.expires_at, exp);
});

test('listScopes excludes expired entries from its counts', async () => {
  const store = createLocalStore(tmpDir());
  await store.write({ scope: 'global', key: 'live', value: 'v' });
  await store.putEntry({
    scope: 'global', key: 'dead', value: 'v', expires_at: '2000-01-01T00:00:00.000Z',
  });
  const scopes = await store.listScopes();
  const global = scopes.find((s) => s.scope === 'global');
  assert.equal(global.count, 1, 'only the unexpired entry is counted');
});
