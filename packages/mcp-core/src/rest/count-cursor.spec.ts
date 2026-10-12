import { describe, it, expect } from 'vitest';
import { buildCountPage, decodeCountCursor, encodeCountCursor } from './count-cursor.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** A `paginate.ts`-shaped date cursor, built the way that module builds one. */
function dateCursor(id: string, ts: string): string {
  return btoa(JSON.stringify({ id, updated_at: ts })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

describe('count cursor codec', () => {
  it('round-trips an id and a count', () => {
    expect(decodeCountCursor(encodeCountCursor(ID, 12))).toEqual({ id: ID, count: 12 });
  });

  it('keeps a count of 0 — the never-chosen tail is a real page boundary', () => {
    expect(decodeCountCursor(encodeCountCursor(ID, 0))).toEqual({ id: ID, count: 0 });
  });

  it('emits URL-safe text with no padding', () => {
    expect(encodeCountCursor(ID, 123_456)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a DATE cursor, so flipping sort mid-pagination restarts at page one', () => {
    expect(decodeCountCursor(dateCursor(ID, '2026-10-01T00:00:00Z'))).toBeNull();
  });

  it.each([
    ['not base64 at all', '%%%'],
    ['valid base64, not JSON', btoa('hello')],
    ['JSON, not an object', btoa('42')],
    ['non-uuid id', btoa(JSON.stringify({ id: 'abc', opened_count: 1 }))],
    ['string count', btoa(JSON.stringify({ id: ID, opened_count: '1' }))],
    ['fractional count', btoa(JSON.stringify({ id: ID, opened_count: 1.5 }))],
    ['negative count', btoa(JSON.stringify({ id: ID, opened_count: -1 }))],
    ['count past int4', btoa(JSON.stringify({ id: ID, opened_count: 2_147_483_648 }))],
  ])('fails closed on %s', (_label, raw) => {
    expect(decodeCountCursor(raw)).toBeNull();
  });
});

describe('buildCountPage', () => {
  const rows = [
    { id: ID, opened_count: 9 },
    { id: ID2, opened_count: 3 },
    { id: '00000000-0000-4000-8000-000000000001', opened_count: 3 },
  ];

  it('reports more pages from the overflow row and cursors on the LAST returned row', () => {
    const page = buildCountPage(rows, 2);
    expect(page.entries).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(decodeCountCursor(page.nextCursor ?? '')).toEqual({ id: ID2, count: 3 });
  });

  it('has no cursor on the last page', () => {
    const page = buildCountPage(rows, 5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('reads a missing counter as 0 rather than minting an undecodable cursor', () => {
    const page = buildCountPage([{ id: ID }, { id: ID2 }], 1);
    expect(decodeCountCursor(page.nextCursor ?? '')).toEqual({ id: ID, count: 0 });
  });
});
