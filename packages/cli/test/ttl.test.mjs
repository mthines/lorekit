// Tests for the local file store's TTL / expiry parity with the hosted store:
// the pure ttl.mjs helpers and their wiring into LocalStore (write, read, list,
// listScopes, putEntry). Before this, `--ttl-days` was silently dropped on a
// local write and local reads never expired anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseTtlDays, expiresAtFrom, isExpired, isLive, resolveExpiresAt, TTL_MAX_DAYS,
  resolveDefaultTtlDays, matchesScopePrefix,
} from '../src/store/ttl.mjs';
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

test('isLive: an entry is live unless archived or expired', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  assert.equal(isLive({ expires_at: null, archived_at: null }, now), true);
  assert.equal(isLive({ expires_at: null, archived_at: '2026-01-01T00:00:00Z' }, now), false);
  assert.equal(isLive({ expires_at: '2026-05-01T00:00:00Z', archived_at: null }, now), false);
  assert.equal(isLive({ expires_at: '2026-07-01T00:00:00Z', archived_at: null }, now), true);
});

test('resolveExpiresAt: clear wins, then set, then keep', () => {
  const now = '2026-01-01T00:00:00.000Z';
  // clear beats an (even invalid) ttl — never validated
  assert.equal(resolveExpiresAt({ clearTtl: true, ttlDays: 999, now, current: 'x' }), null);
  // set from now
  assert.equal(resolveExpiresAt({ ttlDays: 1, now, current: null }), '2026-01-02T00:00:00.000Z');
  // keep existing when neither clear nor ttl supplied
  assert.equal(resolveExpiresAt({ now, current: '2030-01-01T00:00:00.000Z' }), '2030-01-01T00:00:00.000Z');
  // nothing supplied and no existing → permanent
  assert.equal(resolveExpiresAt({ now, current: null }), null);
  // an invalid ttl (not clearing) throws so the caller surfaces ok:false
  assert.throws(() => resolveExpiresAt({ ttlDays: 999, now }), /<= 365/);
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

test('LocalStore clear_ttl short-circuits an INVALID ttl_days (remote parity)', async () => {
  // memory_write (00031) never validates ttl_days when clearing, so a
  // contradictory { clear_ttl, out-of-range ttl_days } clears rather than erroring.
  const store = createLocalStore(tmpDir());
  const res = await store.write({
    scope: 'global', key: 'k', value: 'v', ttl_days: 999, clear_ttl: true,
  });
  assert.equal(res.ok, true);
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

// ── Configured default TTL (resolveDefaultTtlDays) ────────────────────────────
// The client-side policy layer: which TTL applies to a write that named none.
// No server counterpart by design — omitting `ttl_*` on `memory.write` still
// means permanent, so these tests are the whole contract.

test('resolveDefaultTtlDays: null when nothing is configured', () => {
  assert.equal(resolveDefaultTtlDays('repo::owner/name', {}), null);
  assert.equal(resolveDefaultTtlDays('repo::owner/name'), null);
});

test('resolveDefaultTtlDays: falls back to ttl.default when no scope entry matches', () => {
  const control = {
    ttlDefault: 90,
    scopeDefaults: { 'branch::': { ttl_days: 14 } },
  };
  assert.equal(resolveDefaultTtlDays('repo::owner/name', control), 90);
});

test('resolveDefaultTtlDays: a matching scope entry beats ttl.default', () => {
  const control = {
    ttlDefault: 90,
    scopeDefaults: { 'branch::': { ttl_days: 14 } },
  };
  assert.equal(resolveDefaultTtlDays('branch::owner/name::feat-x', control), 14);
});

test('resolveDefaultTtlDays: longest matching prefix wins, not declaration order', () => {
  // Declared broad-first and narrow-first — both must resolve to the narrow one,
  // or the answer depends on whatever order the config author happened to type.
  const broadFirst = {
    scopeDefaults: {
      'repo::': { ttl_days: 30 },
      'repo::owner/name': { ttl_days: 7 },
    },
  };
  const narrowFirst = {
    scopeDefaults: {
      'repo::owner/name': { ttl_days: 7 },
      'repo::': { ttl_days: 30 },
    },
  };
  assert.equal(resolveDefaultTtlDays('repo::owner/name', broadFirst), 7);
  assert.equal(resolveDefaultTtlDays('repo::owner/name', narrowFirst), 7);
});

test('resolveDefaultTtlDays: explicit null means permanent and beats ttl.default', () => {
  const control = {
    ttlDefault: 90,
    scopeDefaults: { global: { ttl_days: null } },
  };
  assert.equal(resolveDefaultTtlDays('global', control), null);
});

test('resolveDefaultTtlDays: an entry without ttl_days does not shadow ttl.default', () => {
  // A tags-only entry is the common case — it must not be read as "permanent".
  const control = {
    ttlDefault: 90,
    scopeDefaults: { 'repo::owner/name': { tags: ['team'] } },
  };
  assert.equal(resolveDefaultTtlDays('repo::owner/name', control), 90);
});

test('resolveDefaultTtlDays: prefix matching is ::-delimited, never a bare substring', () => {
  const control = { scopeDefaults: { 'repo::': { ttl_days: 30 } } };
  assert.equal(resolveDefaultTtlDays('repo::owner/name', control), 30, 'descendant matches');
  assert.equal(resolveDefaultTtlDays('repo::', control), 30, 'exact match');
  assert.equal(
    resolveDefaultTtlDays('repository::owner/name', control),
    null,
    'a scope sharing a text prefix must not inherit',
  );
});

test('resolveDefaultTtlDays: `repo::owner` does not capture `repo::owner/name`', () => {
  // Pins the delimiter semantics inherited from the tags hint: `owner/name` is
  // ONE `::` segment, so an owner-wide entry is not a thing you can express this
  // way. Surprising enough that it deserves a failing test if it ever changes.
  const control = { scopeDefaults: { 'repo::owner': { ttl_days: 30 } } };
  assert.equal(resolveDefaultTtlDays('repo::owner/name', control), null);
  assert.equal(resolveDefaultTtlDays('repo::owner', control), 30, 'exact match still works');
});

test('resolveDefaultTtlDays: an invalid config value degrades to no default, never throws', () => {
  // Ambient state must not be able to break an unrelated write — unlike
  // --ttl-days, which is a caller assertion and errors loudly.
  for (const bad of [0, -1, 1.5, 999, 'soon', true, {}, NaN]) {
    assert.equal(resolveDefaultTtlDays('global', { ttlDefault: bad }), null, `ttl.default=${String(bad)}`);
    assert.equal(
      resolveDefaultTtlDays('global', { scopeDefaults: { global: { ttl_days: bad } } }),
      null,
      `scope ttl_days=${String(bad)}`,
    );
  }
});

test('resolveDefaultTtlDays: numeric strings are accepted (hand-edited JSON)', () => {
  assert.equal(resolveDefaultTtlDays('global', { ttlDefault: '30' }), 30);
});

test('resolveDefaultTtlDays: bounds match the write contract', () => {
  assert.equal(resolveDefaultTtlDays('global', { ttlDefault: 1 }), 1);
  assert.equal(resolveDefaultTtlDays('global', { ttlDefault: TTL_MAX_DAYS }), TTL_MAX_DAYS);
  assert.equal(resolveDefaultTtlDays('global', { ttlDefault: TTL_MAX_DAYS + 1 }), null);
});

test('resolveDefaultTtlDays: a non-object scopeDefaults is ignored', () => {
  assert.equal(resolveDefaultTtlDays('global', { ttlDefault: 30, scopeDefaults: 'nope' }), 30);
  assert.equal(resolveDefaultTtlDays('global', { ttlDefault: 30, scopeDefaults: { global: null } }), 30);
});

test('matchesScopePrefix: total on non-string input', () => {
  assert.equal(matchesScopePrefix(null, 'global'), false);
  assert.equal(matchesScopePrefix('global', ''), false);
  assert.equal(matchesScopePrefix('global', null), false);
});
