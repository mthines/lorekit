/**
 * Label (`memories.tags`) primitives shared by every surface that filters on
 * them: the dashboard's label picker, the `GET /memories` handler's
 * `tags_mode=all` branch, and anything that talks to PostgREST's array
 * operators.
 *
 * This is `filter.ts`'s reasoning applied to a second case — the logic is
 * (a) pure, (b) part of the wire contract, and (c) needed by more than one
 * runtime — so it lives next to the schemas that validate its input rather
 * than being re-derived in the edge tree, where there is no test harness.
 */

/**
 * Trim, drop empties, and dedupe a raw label list, preserving first-seen order.
 *
 * Total function: `undefined`, a non-array, or an array holding non-strings all
 * degrade to the labels that ARE usable rather than throwing — the input can
 * come from a URL param or a query string a user typed by hand.
 */
export function normalizeTagList(values: readonly unknown[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Split the comma-separated `tags` query param into a normalized label list.
 *
 * A label containing a comma is unreachable over this parameter by
 * construction — that is a property of the wire format, not of this function.
 */
export function parseTagsParam(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return normalizeTagList(raw.split(','));
}

/**
 * Build a PostgreSQL array literal (`{"a","b,c"}`) from a label list.
 *
 * postgrest-js's `.contains(column, string[])` / `.overlaps(column, string[])`
 * serialise an array with a bare `value.join(',')`, so a label containing a
 * comma, brace, quote, or backslash is silently mis-parsed into different
 * labels — and `memories.tags` is free text with no CHECK constraint, so such a
 * label is reachable. Passing a STRING instead makes postgrest-js emit
 * `cs.<string>` / `ov.<string>` verbatim, which lets this function own the
 * quoting.
 *
 * Every element is double-quoted (legal for any element, and unambiguous) with
 * `\` and `"` backslash-escaped, per the Postgres array-literal rules.
 */
export function pgArrayLiteral(values: readonly string[]): string {
  const quoted = normalizeTagList(values).map(
    (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return `{${quoted.join(',')}}`;
}
