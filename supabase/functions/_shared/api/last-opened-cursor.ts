/**
 * The keyset cursor for the `sort=last_opened_at` list — "Recent read"
 * (migration 00115): the lessons an agent deliberately read most recently,
 * first, and the never-opened ones after them.
 *
 * Pure and shared (mirrored into `supabase/functions/_shared/api/last-opened-cursor.ts`,
 * guarded by `edge-parity.spec.ts`) so the codec is unit-tested here and the
 * deployed copy cannot drift from what was tested.
 *
 * Why it is not one more case in `_shared/api/paginate.ts`: that cursor's
 * timestamp is never null (both date sorts are NOT NULL columns), its decoder
 * rejects a missing one, and it is byte-mirrored into the MCP function, which
 * has no such sort. `last_opened_at` is NULL for a lesson nothing ever opened,
 * and a page can end inside that never-opened tail — so this cursor must carry
 * a null timestamp, and say so explicitly: `{ id, last_opened_at: null }`.
 *
 * The three formats cannot be mistaken for each other. `paginate.ts`'s decoder
 * finds neither `updated_at` nor `created_at` here, `count-cursor.ts`'s finds
 * no integer `opened_count`, and this decoder requires the `last_opened_at`
 * KEY to be present (with a timestamp or `null`) — so a caller who flips
 * `sort` mid-pagination restarts at page one rather than receiving a page cut
 * at the wrong place.
 */

/**
 * The decoded keyset position: the last row's id and its `last_opened_at` —
 * `null` when that row was never opened, i.e. the page ended inside the tail.
 */
export interface LastOpenedCursor {
  id: string;
  ts: string | null;
}

/** A cursor's `id` is a `memories` primary key, which is a `uuid`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same leading shape `paginate.ts` requires of its timestamp. */
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** base64url without padding — the same alphabet `paginate.ts` uses. */
export function encodeLastOpenedCursor(id: string, ts: string | null): string {
  return btoa(JSON.stringify({ id, last_opened_at: ts }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode a Recent read cursor, or `null` for anything that is not one.
 *
 * Fails CLOSED: the values reach the RPC as typed parameters (`uuid`,
 * `timestamptz`), so a malformed one would be a 500 rather than an injection —
 * and the right answer to a cursor that does not parse is the first page, the
 * same contract `paginate.ts` and `count-cursor.ts` keep.
 */
export function decodeLastOpenedCursor(raw: string): LastOpenedCursor | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const parsed: unknown = JSON.parse(atob(b64 + '='.repeat(pad)));
    if (!parsed || typeof parsed !== 'object' || !('last_opened_at' in parsed)) return null;
    const { id, last_opened_at: ts } = parsed as { id?: unknown; last_opened_at?: unknown };
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    if (ts !== null && (typeof ts !== 'string' || !TS_RE.test(ts))) return null;
    return { id, ts };
  } catch {
    return null;
  }
}

/**
 * The page and its next cursor, from `limit + 1` rows — the overflow row is how
 * `hasMore` is known, exactly as `paginate.ts`'s `buildPage` reads it.
 */
export function buildLastOpenedPage<T extends { id: string; last_opened_at?: string | null }>(
  rows: T[],
  limit: number,
): { entries: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last ? encodeLastOpenedCursor(last.id, last.last_opened_at ?? null) : null;
  return { entries, hasMore, nextCursor };
}
