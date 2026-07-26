/**
 * Pure filter primitives: action-set normalization, substring-needle
 * validation/escaping, and inclusive/half-open date-range boundary math.
 * Audit-decoupled — the allow-set for `normalizeActions` is a parameter, not
 * a hardcoded import, so this module has no dependency on `audit-actions.ts`
 * (the single source of truth for the `AuditAction` union stays there).
 */

/**
 * Dedupe and filter `values` down to only those present in `allowed`.
 * `undefined`/empty input returns `[]` (no filter applied).
 */
export function normalizeActions<A extends string>(
  values: readonly string[] | undefined,
  allowed: readonly A[],
): A[] {
  if (!values || values.length === 0) return [];
  const allowedSet = new Set<string>(allowed);
  const seen = new Set<A>();
  for (const v of values) {
    if (allowedSet.has(v)) seen.add(v as A);
  }
  return Array.from(seen);
}

// PostgREST/`ilike` reserved characters that must be escaped so a substring
// search matches literally instead of being interpreted as a LIKE wildcard
// or a PostgREST filter-list separator.
const ILIKE_ESCAPE_RE = /[%_\\,()]/g;
const ILIKE_ESCAPE_MAP: Record<string, string> = {
  '%': '\\%',
  _: '\\_',
  '\\': '\\\\',
  ',': '\\,',
  '(': '\\(',
  ')': '\\)',
};

/**
 * Trim, validate, and LIKE/PostgREST-escape a raw name-search query.
 * Returns `null` for absent/whitespace-only input (no filter applied).
 * Unicode content is preserved as-is (only the reserved ASCII metacharacters
 * above are escaped).
 */
export function substringNeedle(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(ILIKE_ESCAPE_RE, (ch) => ILIKE_ESCAPE_MAP[ch] ?? ch);
}

export interface DateRangeInput {
  from?: string;
  to?: string;
}

export interface DateRangeBounds {
  gte?: string;
  lt?: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Convert a `{ from, to }` interval (each either a "YYYY-MM-DD" day string
 * or a full ISO timestamp) into inclusive-`from`/exclusive-`to` Postgres
 * bounds:
 *
 * - `from` → `gte`, used as-is (a date-only "YYYY-MM-DD" already sorts as
 *   the start of that UTC day when compared against a timestamptz column).
 * - `to`   → `lt`, a date-only day string is bumped to the START of the
 *   NEXT UTC day so the whole day is included (inclusive semantics); a full
 *   ISO timestamp is used as-is.
 *
 * `null`/`undefined` input, or an input with neither bound set, returns `{}`.
 */
export function dateRangeBounds(range: DateRangeInput | null | undefined): DateRangeBounds {
  if (!range) return {};
  const bounds: DateRangeBounds = {};

  if (range.from) {
    bounds.gte = range.from;
  }

  if (range.to) {
    bounds.lt = DATE_ONLY_RE.test(range.to) ? nextUtcDayStart(range.to) : range.to;
  }

  return bounds;
}

/** "2026-07-26" → "2026-07-27T00:00:00.000Z" (start of the next UTC day). */
function nextUtcDayStart(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
