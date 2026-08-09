// The shared scope-inventory normaliser. Two callers depend on it — the
// `memory.scopes` MCP tool and the SessionStart scope map — and both are
// best-effort paths that cannot afford a throw, so every degradation below is a
// contract rather than an implementation detail.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScopeInventory,
  shapeScopeRow,
  failureReason,
  readScopeInventory,
} from '../src/store/scope-inventory.mjs';

describe('normalizeScopeInventory', () => {
  test('accepts the local store bare-array form', () => {
    assert.deepEqual(normalizeScopeInventory([{ scope: 'global', count: 3 }]), {
      ok: true,
      scopes: [{ scope: 'global', count: 3 }],
      reason: null,
    });
  });

  test('accepts the remote envelope form and keeps last_activity', () => {
    const res = normalizeScopeInventory({
      ok: true,
      scopes: [
        { scope: 'global', count: 12, last_activity: '2026-07-30T09:12:00.000Z' },
        { scope: 'repo::a/b', count: 3 },
      ],
    });
    assert.deepEqual(res.scopes, [
      { scope: 'global', count: 12, last_activity: '2026-07-30T09:12:00.000Z' },
      // OMITTED, never null — a consumer can tell "this store does not report
      // freshness" from "this scope has none".
      { scope: 'repo::a/b', count: 3 },
    ]);
  });

  test('an empty store is a SUCCESS that found nothing, not a failure', () => {
    // Collapsing the two is how a transient network error ends up rendering as
    // an authoritative empty inventory.
    assert.deepEqual(normalizeScopeInventory([]), { ok: true, scopes: [], reason: null });
    assert.deepEqual(normalizeScopeInventory({ ok: true, scopes: [] }), { ok: true, scopes: [], reason: null });
  });

  test('a failed enumeration is ok:false with a bounded reason', () => {
    const cases = [
      [{ ok: false, unusable: true }, /no usable store/],
      [{ ok: false, networkError: 'ECONNREFUSED' }, /network error: ECONNREFUSED/],
      [{ ok: false, httpStatus: 403 }, /HTTP 403/],
      [{ ok: false, error: { httpStatus: 500 } }, /HTTP 500/],
      [{ ok: false, error: { message: 'permission denied' } }, /permission denied/],
      [{ ok: false }, /could not enumerate/],
      [undefined, /no result/],
      [null, /no result/],
    ];
    for (const [input, pattern] of cases) {
      const res = normalizeScopeInventory(input);
      assert.equal(res.ok, false, JSON.stringify(input));
      assert.deepEqual(res.scopes, []);
      assert.match(res.reason, pattern);
    }
  });

  test('the top-level httpStatus wins over a nested application code', () => {
    // `restFetch`'s error object is `{ message, code }` and `code` is the body's
    // own application code, so rendering it as "HTTP <code>" would print a
    // non-status.
    assert.match(failureReason({ ok: false, httpStatus: 429, error: { code: 'rate_limited' } }), /HTTP 429/);
  });

  test('a reason is bounded so a huge upstream message cannot flood a hook', () => {
    const res = normalizeScopeInventory({ ok: false, networkError: 'x'.repeat(5000) });
    assert.ok(res.reason.length < 260, `reason was ${res.reason.length} chars`);
  });
});

describe('shapeScopeRow', () => {
  test('coerces a malformed row rather than propagating it', () => {
    assert.deepEqual(shapeScopeRow({ scope: 'g' }), { scope: 'g', count: 0 });
    assert.deepEqual(shapeScopeRow({ scope: 'g', count: 'lots' }), { scope: 'g', count: 0 });
    assert.deepEqual(shapeScopeRow({ scope: 'g', count: -4 }), { scope: 'g', count: 0 });
    assert.deepEqual(shapeScopeRow({ scope: 'g', count: '7' }), { scope: 'g', count: 7 });
    assert.deepEqual(shapeScopeRow({}), { scope: '', count: 0 });
    assert.deepEqual(shapeScopeRow(null), { scope: '', count: 0 });
  });

  test('reads either spelling of last_activity', () => {
    const iso = '2026-07-30T09:12:00.000Z';
    assert.equal(shapeScopeRow({ scope: 'g', count: 1, last_activity: iso }).last_activity, iso);
    assert.equal(shapeScopeRow({ scope: 'g', count: 1, lastActivity: iso }).last_activity, iso);
  });
});

describe('readScopeInventory', () => {
  test('a store with no listScopes is a reason, not a crash', async () => {
    // A stub, a fixture, or a future adapter may simply not implement it.
    for (const store of [null, undefined, {}, { list: () => {} }]) {
      const res = await readScopeInventory(store);
      assert.equal(res.ok, false);
      assert.match(res.reason, /cannot enumerate/);
    }
  });

  test('a throwing store degrades instead of propagating', async () => {
    const res = await readScopeInventory({ async listScopes() { throw new Error('disk on fire'); } });
    assert.equal(res.ok, false);
    assert.match(res.reason, /scope enumeration failed: disk on fire/);
  });

  test('a rejected promise is caught too, not just a synchronous throw', async () => {
    const res = await readScopeInventory({ listScopes: () => Promise.reject(new Error('nope')) });
    assert.equal(res.ok, false);
    assert.match(res.reason, /nope/);
  });

  test('passes a healthy inventory straight through', async () => {
    const res = await readScopeInventory({ async listScopes() { return [{ scope: 'global', count: 2 }]; } });
    assert.deepEqual(res, { ok: true, scopes: [{ scope: 'global', count: 2 }], reason: null });
  });
});

test('scope-inventory imports nothing — it is on the SessionStart hot path', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../src/store/scope-inventory.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(src, /export function normalizeScopeInventory/, 'guard would be vacuous');
  const code = src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.equal((code.match(/^\s*import\s/gm) || []).length, 0, 'no static imports');
  assert.ok(!/\bimport\s*\(/.test(code), 'no dynamic import()');
});
