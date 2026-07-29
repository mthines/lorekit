/**
 * Cursor-based pagination helpers for LoreKit REST Edge Functions.
 *
 * Uses (updated_at DESC, id DESC) keyset pagination — consistent with the
 * existing audit_log pagination in packages/web/src/lib/pagination/.
 *
 * The cursor is base64url-encoded JSON { t: string, id: string }
 * where t = updated_at ISO timestamp and id = UUID.
 *
 * Usage:
 *   // Decode cursor from query params
 *   const cursor = decodeCursor(params.cursor);
 *
 *   // Apply to Supabase query
 *   let q = db.from('memories').select('...').limit(params.limit + 1);
 *   if (cursor) {
 *     q = q.or(`updated_at.lt.${cursor.t},and(updated_at.eq.${cursor.t},id.lt.${cursor.id})`);
 *   }
 *
 *   // Build page from results
 *   const page = buildPage(data, params.limit, (row) => ({ t: row.updated_at, id: row.id }));
 */

export interface CursorPayload {
  t: string; // updated_at ISO timestamp
  id: string; // UUID
}

/**
 * Encode a cursor payload to an opaque string.
 * The cursor contains no user_id — callers must still apply their own
 * tenant scoping regardless of cursor content.
 */
export function encodeCursor(payload: CursorPayload): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode an opaque cursor string. Fails closed to null on any error —
 * a malformed or forged cursor is treated as "first page", never as an error.
 */
export function decodeCursor(raw: string | undefined | null): CursorPayload | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded);
    const payload = JSON.parse(json) as unknown;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as CursorPayload).t === 'string' &&
      typeof (payload as CursorPayload).id === 'string'
    ) {
      return payload as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export interface Page<T> {
  entries: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Build a pagination page from a query result.
 *
 * Fetch (limit + 1) rows from the DB. Pass all of them here.
 * This function slices to `limit` entries and generates the cursor
 * pointing at the last returned row.
 *
 * @param rows    All rows returned by the DB (length may be limit+1)
 * @param limit   The page size requested by the caller
 * @param getCursorPayload  Extract { t, id } from a row to build the cursor
 */
export function buildPage<T extends object>(
  rows: T[],
  limit: number,
  getCursorPayload: (row: T) => CursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = entries.at(-1);
  const nextCursor = hasMore && lastRow ? encodeCursor(getCursorPayload(lastRow)) : null;
  return { entries, nextCursor, hasMore };
}
