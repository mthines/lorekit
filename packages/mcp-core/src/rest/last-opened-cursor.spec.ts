import { describe, it, expect } from 'vitest';
import {
  buildLastOpenedPage,
  decodeLastOpenedCursor,
  encodeLastOpenedCursor,
} from './last-opened-cursor.ts';
import { decodeCountCursor, encodeCountCursor } from './count-cursor.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TS = '2026-10-20T09:15:00.123+00:00';

/** A `paginate.ts`-shaped date cursor, built the way that module builds one. */
function dateCursor(id: string, field: 'updated_at' | 'created_at', ts: string): string {
  return btoa(JSON.stringify({ id, [field]: ts })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

describe('last_opened_at cursor codec', () => {
  it('round-trips an id and a timestamp', () => {
    expect(decodeLastOpenedCursor(encodeLastOpenedCursor(ID, TS))).toEqual({ id: ID, ts: TS });
  });

  it('keeps a NULL timestamp — a page that ended inside the never-opened tail is a real boundary', () => {
    expect(decodeLastOpenedCursor(encodeLastOpenedCursor(ID, null))).toEqual({ id: ID, ts: null });
  });

  it('emits URL-safe text with no padding', () => {
    expect(encodeLastOpenedCursor(ID, TS)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeLastOpenedCursor(ID, null)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['an updated_at date cursor', dateCursor(ID, 'updated_at', TS)],
    ['a created_at date cursor', dateCursor(ID, 'created_at', TS)],
    ['an opened_count cursor', encodeCountCursor(ID, 3)],
  ])('refuses %s, so flipping sort mid-pagination restarts at page one', (_label, raw) => {
    expect(decodeLastOpenedCursor(raw)).toBeNull();
  });

  it('is refused by the count decoder in turn', () => {
    expect(decodeCountCursor(encodeLastOpenedCursor(ID, TS))).toBeNull();
    expect(decodeCountCursor(encodeLastOpenedCursor(ID, null))).toBeNull();
  });

  it.each([
    ['not base64 at all', '%%%'],
    ['valid base64, not JSON', btoa('hello')],
    ['JSON, not an object', btoa('42')],
    ['JSON null', btoa('null')],
    ['the key absent (an id alone is not this cursor)', btoa(JSON.stringify({ id: ID }))],
    ['non-uuid id', btoa(JSON.stringify({ id: 'abc', last_opened_at: TS }))],
    ['numeric timestamp', btoa(JSON.stringify({ id: ID, last_opened_at: 1_760_000_000 }))],
    ['free-text timestamp', btoa(JSON.stringify({ id: ID, last_opened_at: 'yesterday' }))],
    ['a timestamp carrying a PostgREST operator', btoa(JSON.stringify({ id: ID, last_opened_at: ',id.gt.0' }))],
  ])('fails closed on %s', (_label, raw) => {
    expect(decodeLastOpenedCursor(raw)).toBeNull();
  });
});

describe('buildLastOpenedPage', () => {
  const rows = [
    { id: ID, last_opened_at: TS },
    { id: ID2, last_opened_at: null },
    { id: '00000000-0000-4000-8000-000000000001', last_opened_at: null },
  ];

  it('reports more pages from the overflow row and cursors on the LAST returned row', () => {
    const page = buildLastOpenedPage(rows, 1);
    expect(page.entries).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(decodeLastOpenedCursor(page.nextCursor ?? '')).toEqual({ id: ID, ts: TS });
  });

  it('mints a NULL-timestamp cursor when the page ends inside the never-opened tail', () => {
    const page = buildLastOpenedPage(rows, 2);
    expect(page.hasMore).toBe(true);
    expect(decodeLastOpenedCursor(page.nextCursor ?? '')).toEqual({ id: ID2, ts: null });
  });

  it('has no cursor on the last page', () => {
    const page = buildLastOpenedPage(rows, 5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('reads a missing column as never opened rather than minting an undecodable cursor', () => {
    const page = buildLastOpenedPage([{ id: ID }, { id: ID2 }], 1);
    expect(decodeLastOpenedCursor(page.nextCursor ?? '')).toEqual({ id: ID, ts: null });
  });
});
