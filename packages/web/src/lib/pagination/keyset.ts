/**
 * Pure keyset-pagination primitives: page-size clamping, the `(created_at,
 * id)` keyset predicate, and fetch+1 → page assembly. Decoupled from audit —
 * any `(timestamp, id)`-ordered table can reuse these.
 */

import { encodeCursor, type KeysetCursor } from './cursor';

/** Column names the keyset predicate is built against. */
export interface KeysetColumns {
  ts: string;
  id: string;
}

const DEFAULT_COLS: KeysetColumns = { ts: 'created_at', id: 'id' };

/**
 * Clamp a requested page size to `[1, max]`, defaulting to `def` when
 * `requested` is absent, non-finite, zero, or negative.
 */
export function clampPageSize(
  requested: number | undefined,
  opts: { def: number; max: number },
): number {
  const { def, max } = opts;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(def, max);
  }
  return Math.min(Math.floor(requested), max);
}

/**
 * Build the PostgREST `.or()` predicate string for "rows strictly after this
 * cursor" in `(ts desc, id desc)` order:
 *
 *   created_at.lt.<c>,and(created_at.eq.<c>,id.lt.<id>)
 *
 * Returns `null` when `cursor` is `null` (first page — no predicate needed).
 */
export function keysetOrPredicate(
  cursor: KeysetCursor | null,
  cols: KeysetColumns = DEFAULT_COLS,
): string | null {
  if (!cursor) return null;
  const { ts, id } = cols;
  return `${ts}.lt.${cursor.c},and(${ts}.eq.${cursor.c},${id}.lt.${cursor.id})`;
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Assemble a page from a fetch of up to `pageSize + 1` rows (the "fetch one
 * extra to detect more" idiom — avoids a separate COUNT query).
 *
 * - `fetched.length > pageSize` → trim to `pageSize`, `hasMore: true`,
 *   `nextCursor` derived from the last KEPT row.
 * - Otherwise → all rows kept, `hasMore: false`, `nextCursor: null`.
 */
export function assemblePage<T>(
  fetched: T[],
  pageSize: number,
  toCursor: (row: T) => KeysetCursor,
): Page<T> {
  const hasMore = fetched.length > pageSize;
  const rows = hasMore ? fetched.slice(0, pageSize) : fetched;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null;
  return { rows, nextCursor, hasMore };
}
