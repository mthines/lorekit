import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRows, encodeCursor, decodeCursor, applyCursor, buildPage, paginate } from './paginate.mjs';

function makeRows(n) {
  // Distinct updated_at per row so ordering is unambiguous, plus a distinct id.
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(3, '0')}`,
    updated_at: new Date(2026, 0, 1 + i).toISOString(),
    created_at: new Date(2026, 0, 1 + i).toISOString(),
  }));
}

test('sortRows orders by sort column desc, id desc as tiebreak', () => {
  const rows = [
    { id: 'a', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'b', updated_at: '2026-01-03T00:00:00.000Z' },
    { id: 'c', updated_at: '2026-01-02T00:00:00.000Z' },
  ];
  assert.deepEqual(sortRows(rows, 'updated_at').map((r) => r.id), ['b', 'c', 'a']);
});

test('sortRows tiebreaks equal sort values by id desc', () => {
  const rows = [
    { id: 'a', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'z', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'm', updated_at: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(sortRows(rows, 'updated_at').map((r) => r.id), ['z', 'm', 'a']);
});

test('cursor round-trips through encode/decode', () => {
  const row = { id: 'abc', updated_at: '2026-01-01T00:00:00.000Z' };
  const cursor = encodeCursor(row, 'updated_at');
  assert.deepEqual(decodeCursor(cursor), { sort: 'updated_at', ts: '2026-01-01T00:00:00.000Z', id: 'abc' });
});

test('decodeCursor fails closed to null on malformed/forged/truncated input', () => {
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('not-base64url-json'), null);
  assert.equal(decodeCursor(Buffer.from('{"sort":"updated_at"}').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('null').toString('base64url')), null);
});

test('a cursor minted under a different sort column is ignored (first page)', () => {
  const rows = sortRows(makeRows(3), 'updated_at');
  const cursor = { sort: 'created_at', ts: rows[0].created_at, id: rows[0].id };
  assert.deepEqual(applyCursor(rows, cursor, 'updated_at'), rows);
});

test('buildPage reports hasMore + nextCursor exactly when more rows exist', () => {
  const rows = sortRows(makeRows(5), 'updated_at');
  const page = buildPage(rows, 3, 'updated_at');
  assert.equal(page.entries.length, 3);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);

  const lastPage = buildPage(rows.slice(0, 3), 3, 'updated_at');
  assert.equal(lastPage.hasMore, false);
  assert.equal(lastPage.nextCursor, null);
});

test('paginate pages through a full set with no overlap and no gap', () => {
  const rows = makeRows(10);
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const page = paginate(rows, { sort: 'updated_at', limit: 3, cursor });
    seen.push(...page.entries.map((r) => r.id));
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  const expected = sortRows(rows, 'updated_at').map((r) => r.id);
  assert.deepEqual(seen, expected, 'every row must appear exactly once, in the same order as a single unpaginated pass');
  assert.equal(new Set(seen).size, seen.length, 'no row must repeat across pages (no overlap)');
});

test('paginate with limit >= row count returns everything in one page', () => {
  const rows = makeRows(4);
  const page = paginate(rows, { sort: 'updated_at', limit: 50 });
  assert.equal(page.entries.length, 4);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});
