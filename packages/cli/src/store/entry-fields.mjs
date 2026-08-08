// The read-shape fields a ranking layer needs, derived from a store row.
//
// Both stores answer with rows in their OWN vocabulary — the remote store hands
// back a REST `MemoryEntry` (`seen_count`, `updated_at`), the local store hands
// back parsed frontmatter (`seen_count`, `updated`). A ranker cannot care which
// one it is holding, so the projection lives here, once, and both stores apply
// it on the way out. Two copies of "which key holds the timestamp" is exactly
// the drift the repo's mirror guards exist to prevent.
//
// TOTAL FUNCTIONS. Every entry point below is defined for any input — a null
// row, a string where a number belongs, a hand-edited frontmatter scalar, a
// response from a backend deployed before the column existed. This code runs on
// the SessionStart hot path behind a hook that must always exit 0, so a throw
// here would cost the user their lesson injection to save a field nobody
// promised. Missing or unusable degrades to the documented default and the
// caller ranks on what it does have.
//
// Zero-dependency: no imports, not even node builtins.

/**
 * How many times this lesson has been written.
 *
 * `0` — not `1` — is the absent case, and the distinction is load-bearing.
 * A live remote row always carries at least `1` (the column is `NOT NULL
 * DEFAULT 1`), so `0` can only mean "this store did not tell me", which a
 * salience score should read as no evidence rather than as one sighting.
 * Fractions are floored and negatives clamped: the count is a tally.
 */
export function seenCountOf(row) {
  const raw = row?.seen_count;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * When this lesson was last written, as an ISO 8601 string, or `null`.
 *
 * Accepts either store's spelling (`updated_at` remote, `updated` local) and
 * normalises through `Date` so a caller can compare two stores' entries without
 * knowing which produced them. An unparseable value is `null`, never `Invalid
 * Date` and never the raw text: a recency decay fed `NaN` silently sinks the
 * entry to the bottom, which is a worse failure than admitting the timestamp is
 * unknown.
 */
export function updatedAtOf(row) {
  const raw = row?.updated_at ?? row?.updated;
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A store row plus the two derived read fields.
 *
 * ADDITIVE by construction: the row is spread through untouched, so every
 * existing caller keeps reading the exact keys it always did and only a caller
 * that asks for `seenCount` / `updatedAt` sees anything new. A non-object row
 * yields the defaults rather than throwing, so a malformed page cannot take
 * down a whole listing.
 */
export function withReadFields(row) {
  return {
    ...(row && typeof row === 'object' ? row : {}),
    seenCount: seenCountOf(row),
    updatedAt: updatedAtOf(row),
  };
}
