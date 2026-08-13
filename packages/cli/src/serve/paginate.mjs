// Pure keyset pagination over an already-filtered, in-memory row array — the
// local-store counterpart to `packages/web/src/lib/pagination/keyset.ts` and
// the edge handler's `buildPage`/`decodeCursor` (`_shared/api/paginate.ts`).
//
// The shape is the same "fetch the whole candidate set, sort, cut a page"
// idiom the REST route uses (there, "fetch" means `limit + 1` rows from
// Postgres; here it means the whole filtered array, which is cheap because a
// local store's row count is small) — so the CURSOR SEMANTICS are identical:
// rows strictly after the cursor's `(sort column, id)` position, in the same
// `(sort desc, id desc)` order the list route emits, with no overlap or gap
// between successive pages.
//
// Zero-dependency: no imports.

/** `(sort desc, id desc)` — matches `handleList`'s `.order(sort, {ascending:
 * false}).order('id', {ascending: false})`. String comparison is correct for
 * both an ISO timestamp and a UUID: neither needs numeric comparison to sort
 * consistently with itself, which is all a stable tiebreak needs. */
export function sortRows(rows, sort) {
  return [...rows].sort((a, b) => {
    const av = String(a[sort] ?? '');
    const bv = String(b[sort] ?? '');
    if (av !== bv) return av < bv ? 1 : -1;
    const aid = String(a.id ?? '');
    const bid = String(b.id ?? '');
    if (aid !== bid) return aid < bid ? 1 : -1;
    return 0;
  });
}

/** Opaque cursor encoding — base64url JSON, mirroring the web's `cursor.ts`
 * shape but carrying `sort` too, since (unlike the audit log) this route
 * supports two different sort columns and a cursor minted under one is not
 * comparable under the other. */
export function encodeCursor(row, sort) {
  return Buffer.from(JSON.stringify({ sort, ts: String(row[sort] ?? ''), id: String(row.id ?? '') }), 'utf8').toString('base64url');
}

/** Decode a cursor. Returns `null` for anything malformed, forged, or
 * truncated — never throws (the `decodeCursor` contract every cursor codec in
 * this repo follows). */
export function decodeCursor(raw) {
  if (!raw) return null;
  let json;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !parsed || typeof parsed !== 'object' ||
    typeof parsed.sort !== 'string' || typeof parsed.ts !== 'string' || typeof parsed.id !== 'string'
  ) {
    return null;
  }
  return parsed;
}

/**
 * Keep only rows strictly AFTER `cursor` in `(sort desc, id desc)` order.
 *
 * A cursor minted under a different sort column is IGNORED (→ first page)
 * rather than mis-applied — mirroring `handleList`'s `c.sort === sort` guard,
 * because a `created_at` position is not comparable against an `updated_at`
 * ordering.
 */
export function applyCursor(sortedRows, cursor, sort) {
  if (!cursor || cursor.sort !== sort) return sortedRows;
  return sortedRows.filter((row) => {
    const v = String(row[sort] ?? '');
    if (v < cursor.ts) return true;
    if (v > cursor.ts) return false;
    return String(row.id ?? '') < cursor.id;
  });
}

/**
 * Assemble one page from a fully sorted+cursor-filtered row array: keep at
 * most `limit`, and report `hasMore`/`nextCursor` from the (limit+1)-th row —
 * the same "fetch one extra to detect more" idiom `assemblePage` (web) and
 * `buildPage` (edge) both use, so paging never overlaps or gaps.
 */
export function buildPage(rows, limit, sort) {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last, sort) : null;
  return { entries, hasMore, nextCursor };
}

/**
 * The full pipeline: sort the filtered rows, apply the cursor, cut the page.
 * The one function `routes.mjs` calls for `GET /memories`.
 */
export function paginate(rows, { sort = 'updated_at', limit = 50, cursor = null } = {}) {
  const sorted = sortRows(rows, sort);
  const decoded = decodeCursor(cursor);
  const afterCursor = applyCursor(sorted, decoded, sort);
  return buildPage(afterCursor, limit, sort);
}
