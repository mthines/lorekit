/**
 * Keyset pagination for the REST list routes.
 *
 * The cursor is an opaque base64url payload naming the last row of the page it
 * was minted from: its id plus the value of the SORT column. `updated_at` was
 * the only sort order when this was written, so that field name is the wire
 * format for it and stays untouched — a cursor minted before `sort` existed
 * still decodes. `created_at` sorting adds a second field rather than
 * repurposing the first, so a cursor always says which order produced it and a
 * caller who flips `sort` mid-pagination gets a clean restart instead of a
 * silently wrong page (`handleList` drops a cursor whose sort disagrees).
 */

/** The columns a keyset page can be ordered by. */
export type SortColumn = 'updated_at' | 'created_at';

export function encodeCursor(id: string, ts: string, sort: SortColumn = 'updated_at'): string {
  return btoa(JSON.stringify({ id, [sort]: ts })).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

export interface DecodedCursor {
  id: string;
  /** The sort column's value on the last row of the previous page. */
  ts: string;
  sort: SortColumn;
}

export function decodeCursor(c: string): DecodedCursor | null {
  try {
    const p = c.replace(/-/g,'+').replace(/_/g,'/');
    const pad = (4 - (p.length % 4)) % 4;
    const d = JSON.parse(atob(p + '='.repeat(pad)));
    if (typeof d.id !== 'string') return null;
    const sort: SortColumn = typeof d.updated_at === 'string' ? 'updated_at' : 'created_at';
    const ts = d[sort];
    if (typeof ts !== 'string') return null;
    // Validate the timestamp is a safe ISO value — blocks PostgREST filter injection
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(ts)) return null;
    return { id: d.id, ts, sort };
  } catch { return null; }
}

export interface PageResult<T> { entries: T[]; hasMore: boolean; nextCursor: string | null; }

export function buildPage<T extends { id: string; updated_at: string; created_at?: string }>(
  rows: T[],
  limit: number,
  sort: SortColumn = 'updated_at',
): PageResult<T> {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const ts = last ? (last[sort] as string | undefined) : undefined;
  return { entries, hasMore, nextCursor: hasMore && last && ts ? encodeCursor(last.id, ts, sort) : null };
}
