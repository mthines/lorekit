/**
 * The keyset cursor for the `sort=opened_count` list — "most chosen first"
 * (migration 00113).
 *
 * Pure and shared (mirrored into `supabase/functions/_shared/api/count-cursor.ts`,
 * guarded by `edge-parity.spec.ts`) so the codec is unit-tested here and the
 * deployed copy cannot drift from what was tested.
 *
 * Why it is not one more case in `_shared/api/paginate.ts`: that cursor carries
 * a TIMESTAMP — both date sorts put their last row's value in it and the list
 * RPC compares it as `timestamptz` — and `paginate.ts` is byte-mirrored into the
 * MCP function, which has no count sort. An integer bound needs an integer
 * field, so this is its own codec with its own shape: `{ id, opened_count }`.
 *
 * The two formats cannot be mistaken for each other. `paginate.ts`'s decoder
 * finds neither `updated_at` nor `created_at` in a count cursor and drops it,
 * and this decoder finds no integer `opened_count` in a date cursor and drops
 * that. A caller who flips `sort` mid-pagination therefore restarts at page one
 * rather than receiving a page cut at the wrong place.
 */

/** The decoded keyset position: the last row's id and its `opened_count`. */
export interface CountCursor {
  id: string;
  count: number;
}

/** A cursor's `id` is a `memories` primary key, which is a `uuid`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `opened_count` is a Postgres `integer`, so a bound past int4 cannot be a real row's value. */
const INT4_MAX = 2_147_483_647;

/** base64url without padding — the same alphabet `paginate.ts` uses. */
export function encodeCountCursor(id: string, count: number): string {
  return btoa(JSON.stringify({ id, opened_count: count }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode a count cursor, or `null` for anything that is not one.
 *
 * Fails CLOSED: the values reach the RPC as typed parameters (`uuid`,
 * `integer`), so a malformed one would be a 500 rather than an injection — and
 * the right answer to a cursor that does not parse is the first page, the same
 * contract `paginate.ts` keeps.
 */
export function decodeCountCursor(raw: string): CountCursor | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const parsed: unknown = JSON.parse(atob(b64 + '='.repeat(pad)));
    if (!parsed || typeof parsed !== 'object') return null;
    const { id, opened_count: count } = parsed as { id?: unknown; opened_count?: unknown };
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > INT4_MAX) return null;
    return { id, count };
  } catch {
    return null;
  }
}

/**
 * The page and its next cursor, from `limit + 1` rows — the overflow row is how
 * `hasMore` is known, exactly as `paginate.ts`'s `buildPage` reads it.
 */
export function buildCountPage<T extends { id: string; opened_count?: number | null }>(
  rows: T[],
  limit: number,
): { entries: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last ? encodeCountCursor(last.id, last.opened_count ?? 0) : null;
  return { entries, hasMore, nextCursor };
}
