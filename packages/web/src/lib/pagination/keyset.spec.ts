import { describe, it, expect } from 'vitest';
import { clampPageSize, keysetOrPredicate, assemblePage } from './keyset';
import { decodeCursor } from './cursor';

describe('clampPageSize', () => {
  const opts = { def: 50, max: 100 };

  it('defaults when requested is absent', () => {
    expect(clampPageSize(undefined, opts)).toBe(50);
  });

  it('defaults when requested is 0', () => {
    expect(clampPageSize(0, opts)).toBe(50);
  });

  it('defaults when requested is negative', () => {
    expect(clampPageSize(-5, opts)).toBe(50);
  });

  it('clamps to max when requested exceeds it', () => {
    expect(clampPageSize(250, opts)).toBe(100);
  });

  it('passes through a value exactly at max', () => {
    expect(clampPageSize(100, opts)).toBe(100);
  });

  it('passes through a value exactly at default', () => {
    expect(clampPageSize(50, opts)).toBe(50);
  });

  it('passes through a small in-range value', () => {
    expect(clampPageSize(10, opts)).toBe(10);
  });

  it('floors a non-integer request', () => {
    expect(clampPageSize(10.9, opts)).toBe(10);
  });

  it('defaults when requested is NaN or Infinity', () => {
    expect(clampPageSize(Number.NaN, opts)).toBe(50);
    expect(clampPageSize(Number.POSITIVE_INFINITY, opts)).toBe(50);
  });
});

describe('keysetOrPredicate', () => {
  it('returns null for a null cursor (first page)', () => {
    expect(keysetOrPredicate(null)).toBeNull();
  });

  it('builds the composite lt/eq-and-lt predicate string for a cursor', () => {
    const cursor = { c: '2026-07-01T10:00:00.000Z', id: '00000000-0000-0000-0000-000000000001' };
    expect(keysetOrPredicate(cursor)).toBe(
      'created_at.lt.2026-07-01T10:00:00.000Z,and(created_at.eq.2026-07-01T10:00:00.000Z,id.lt.00000000-0000-0000-0000-000000000001)',
    );
  });

  it('honors custom column names', () => {
    const cursor = { c: '2026-07-01T10:00:00.000Z', id: 'abc' };
    expect(keysetOrPredicate(cursor, { ts: 'updated_at', id: 'row_id' })).toBe(
      'updated_at.lt.2026-07-01T10:00:00.000Z,and(updated_at.eq.2026-07-01T10:00:00.000Z,row_id.lt.abc)',
    );
  });
});

describe('assemblePage', () => {
  interface Row {
    created_at: string;
    id: string;
  }
  const toCursor = (r: Row) => ({ c: r.created_at, id: r.id });
  const row = (i: number): Row => ({
    created_at: `2026-07-01T10:00:0${i}.000Z`,
    id: `00000000-0000-0000-0000-00000000000${i}`,
  });

  it('when fetched === pageSize (no extra row): hasMore false, nextCursor null, all rows kept', () => {
    const fetched = [row(1), row(2), row(3)];
    const page = assemblePage(fetched, 3, toCursor);
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('when fetched < pageSize (exhausted early): hasMore false, nextCursor null', () => {
    const fetched = [row(1)];
    const page = assemblePage(fetched, 5, toCursor);
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('when fetched === pageSize + 1 (cursor-at-boundary): trims to pageSize, hasMore true, nextCursor set from last KEPT row', () => {
    const fetched = [row(1), row(2), row(3), row(4)]; // pageSize=3, +1 extra
    const page = assemblePage(fetched, 3, toCursor);
    expect(page.rows).toHaveLength(3);
    expect(page.rows[page.rows.length - 1]).toEqual(row(3)); // 4th (extra) row trimmed off
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    // nextCursor decodes back to the cursor of the last KEPT row (row 3), not the trimmed extra.
    expect(decodeCursor(page.nextCursor)).toEqual(toCursor(row(3)));
  });

  it('handles an empty fetch', () => {
    const page = assemblePage<Row>([], 50, toCursor);
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
