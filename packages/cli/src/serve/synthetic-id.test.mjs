import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticId, resolveSyntheticId } from './synthetic-id.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('syntheticId is a valid UUIDv5 (version + variant bits set)', () => {
  const id = syntheticId('global', 'my-key');
  assert.match(id, UUID_RE);
});

test('syntheticId is deterministic — same scope+key always yields the same id', () => {
  const a = syntheticId('repo::acme/widget', 'build-flags');
  const b = syntheticId('repo::acme/widget', 'build-flags');
  assert.equal(a, b);
});

test('syntheticId is distinct across different scope/key pairs', () => {
  const ids = new Set([
    syntheticId('global', 'a'),
    syntheticId('global', 'b'),
    syntheticId('project::x', 'a'),
    syntheticId('a', 'b::c'),
    syntheticId('a::b', 'c'),
  ]);
  assert.equal(ids.size, 5, 'every pair must hash to a distinct id, including the NUL-separator edge case');
});

test('resolveSyntheticId finds the row whose scope+key hashes to the given id', () => {
  const rows = [
    { scope: 'global', key: 'a' },
    { scope: 'global', key: 'b' },
    { scope: 'repo::acme/widget', key: 'c' },
  ];
  const id = syntheticId('repo::acme/widget', 'c');
  const found = resolveSyntheticId(id, rows);
  assert.deepEqual(found, { scope: 'repo::acme/widget', key: 'c' });
});

test('resolveSyntheticId returns null for an id no row produces', () => {
  const rows = [{ scope: 'global', key: 'a' }];
  assert.equal(resolveSyntheticId(syntheticId('global', 'zzz'), rows), null);
});

test('resolveSyntheticId is total: bad inputs degrade to null, never throw', () => {
  assert.equal(resolveSyntheticId(null, [{ scope: 'a', key: 'b' }]), null);
  assert.equal(resolveSyntheticId('not-a-uuid', null), null);
  assert.equal(resolveSyntheticId('not-a-uuid', [null, undefined, { scope: 'a', key: 'b' }]), null);
});
