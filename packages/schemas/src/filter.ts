/**
 * Filter serialisation — the OR+AND filter tree → PostgREST clause strings.
 *
 * This is the pure half of the `filter` parameter accepted by
 * `POST /memories/search`. It lives here, next to `FilterGroupSchema`, because
 * it is part of the API contract: the schema says which shapes are accepted,
 * this module says what each shape means. The Deno edge adapter
 * (`supabase/functions/_shared/api/filter.ts`) only applies the strings this
 * module produces to a Supabase query builder.
 *
 * Keeping it here means it is unit-testable in Node, shareable with any other
 * client that needs to build the same predicate, and impossible to drift from
 * the schema that validates its input.
 */

import type { FilterCondition, FilterGroup } from './common.ts';

/**
 * Columns a caller is allowed to filter on.
 *
 * This is a whitelist, not a blacklist: anything not listed here is dropped
 * silently rather than passed through to PostgREST, so a caller can never
 * name an arbitrary column (`user_id`, `org_id`, `archived_at`, …) and widen
 * or subvert the tenant/visibility predicates the handler applies separately.
 */
export const ALLOWED_FILTER_FIELDS: ReadonlySet<string> = new Set([
  'scope',
  'key',
  'value',
  'tags',
  'source_agent',
  'trigger',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Value encoding — ONE mechanism, the one PostgREST documents.
//
// There are two independent escaping problems here and they are solved in two
// separate steps, in this order:
//
//   1. LIKE metacharacters (`%`, `_`, and the `\` escape itself) — so a user
//      typing `100%` searches for the text `100%` instead of matching
//      everything. Postgres' default LIKE escape character is a backslash.
//   2. PostgREST's URL grammar — so a value containing one of its reserved
//      characters (`,` `.` `:` `(` `)`) cannot terminate the clause it sits in
//      and inject a sibling predicate. The documented remedy is to wrap the
//      value in DOUBLE QUOTES, escaping `\` and `"` inside them with a
//      backslash. See "Reserved characters" in the PostgREST URL grammar.
//
// This replaces an earlier percent-encoding attempt (`encodeForPostgrest`,
// `,`/`(`/`)` → `%2C`/`%28`/`%29`), which could not work: every one of these
// expressions is handed to postgrest-js `.or()`, which does
// `url.searchParams.append('or', '(…)')` — a `URLSearchParams` serialisation
// re-encodes the `%` as `%25`, so `%2C` arrives at PostgREST as the literal
// four-character text `%2C`. It neither separated a clause nor matched a
// comma. The two call sites also disagreed: `likeNeedle` backslash-escaped the
// same three characters instead, which the URL grammar gives no meaning to.
//
// Grounding for the quoted form (this repo cannot run a PostgREST to check):
// the logic-tree value parser is
// `pLogicSingleVal = try (pQuotedValue <* notFollowedBy (noneOf ",)")) <|> …`
// with `pQuotedValue = char '"' *> many (noneOf "\\\"" <|> char '\\' *> anyChar) <* char '"'`
// (`src/PostgREST/ApiRequest/QueryParams.hs`, unchanged across v12 and v13) —
// quotes are stripped, a backslash escapes the character after it, and the
// closing quote must be followed by `,`, `)`, or the end of the tree.
// ─────────────────────────────────────────────────────────────────────────────

/** Postgres LIKE metacharacters, plus the backslash that escapes them. */
const LIKE_ESCAPE_RE = /[%_\\]/g;

/**
 * Trim a raw substring query and escape the LIKE metacharacters in it.
 *
 * Returns `null` for absent/whitespace-only input, meaning "apply no filter" —
 * so a caller can pass raw user input straight through. Unicode content is
 * preserved as-is; only `%`, `_` and `\` are escaped.
 *
 * The result is a LIKE *pattern fragment*, NOT a finished clause: wrap it in
 * `%…%` for a contains match and pass the whole pattern through
 * {@link quoteFilterValue} before putting it in a logic tree. {@link ilikeClause}
 * does both, and is what every caller should use.
 *
 * Shared rather than re-derived per surface because BOTH the dashboard's search
 * and the `GET /memories` `q` filter must escape identically — an unescaped `%`
 * silently turns an as-you-type filter into a match-everything wildcard.
 *
 * `*` is deliberately NOT escaped: PostgREST translates `*` to `%` only for the
 * quantified `like(any)` / `like(all)` forms (`T.map star val` in
 * `SqlFragment.hs`), never for the plain `ilike` this module emits, so a
 * literal asterisk stays literal.
 */
export function likeNeedle(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(LIKE_ESCAPE_RE, (ch) => `\\${ch}`);
}

/**
 * Wrap a value for use INSIDE a PostgREST logic tree (`or=(…)` / `and=(…)`).
 *
 * Always quotes, rather than quoting only when a reserved character is present:
 * a value is either safe in every case or safe in no case, and a conditional
 * would make the dangerous branch the rarely-exercised one.
 *
 * Only valid inside a logic tree. A top-level filter (`?key=ilike.…`) is parsed
 * by `pSingleVal = many anyChar`, which strips nothing — quotes there would be
 * matched as literal characters.
 */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One `ilike` clause for a logic tree: `<field>.ilike."<pattern>"`.
 *
 * `needle` must already be LIKE-escaped ({@link likeNeedle}); the `%` wildcards
 * this adds are the only ones that stay active. Exported so the `q` filter and
 * the `contains` operator of a `FilterGroup` compose the clause the same way —
 * that they did not is what let the two encodings drift apart.
 */
export function ilikeClause(
  field: string,
  needle: string,
  {
    prefix = true,
    suffix = true,
    negate = false,
  }: { prefix?: boolean; suffix?: boolean; negate?: boolean } = {},
): string {
  const pattern = `${prefix ? '%' : ''}${needle}${suffix ? '%' : ''}`;
  return `${field}.${negate ? 'not.ilike' : 'ilike'}.${quoteFilterValue(pattern)}`;
}

/** Serialise a single leaf condition, or `null` if its field is not allowed. */
function conditionToString(c: FilterCondition): string | null {
  if (!ALLOWED_FILTER_FIELDS.has(c.field)) return null;
  const raw = c.value ?? '';
  // Equality compares the value verbatim, so it is quoted but NOT LIKE-escaped.
  const exact = quoteFilterValue(raw);
  // The pattern operators do both: a `%` the user typed is data, not a wildcard.
  const needle = raw.replace(LIKE_ESCAPE_RE, (ch) => `\\${ch}`);
  switch (c.op) {
    case 'is':               return `${c.field}.eq.${exact}`;
    case 'is_not':           return `${c.field}.neq.${exact}`;
    case 'contains':         return ilikeClause(c.field, needle);
    case 'does_not_contain': return ilikeClause(c.field, needle, { negate: true });
    case 'starts_with':      return ilikeClause(c.field, needle, { prefix: false });
    case 'ends_with':        return ilikeClause(c.field, needle, { suffix: false });
    case 'is_set':           return `${c.field}.not.is.null`;
    case 'is_not_set':       return `${c.field}.is.null`;
    default:                 return null;
  }
}

/**
 * Serialise a node into a single PostgREST `or()`-compatible expression.
 * A nested AND becomes PostgREST's `and(...)` syntax, because inside an OR
 * expression there is no query-builder call to chain onto.
 */
function groupToOrString(g: FilterGroup): string | null {
  if ('and' in g) {
    const parts = g.and.map(groupToOrString).filter((s): s is string => s !== null);
    if (!parts.length) return null;
    return `and(${parts.join(',')})`;
  }
  if ('or' in g) {
    const parts = g.or.map(groupToOrString).filter((s): s is string => s !== null);
    if (!parts.length) return null;
    return parts.join(',');
  }
  return conditionToString(g as FilterCondition);
}

/**
 * Serialise a filter tree into the list of PostgREST `or()` expressions that
 * express it.
 *
 * The returned array is an **AND-list**: PostgREST ANDs successive `.or()`
 * calls together, so each element is one conjunct and the elements within an
 * element (comma-separated) are disjuncts. An empty array means "no
 * constraint" — either no filter was supplied, or every branch named a field
 * outside {@link ALLOWED_FILTER_FIELDS}.
 *
 * @example
 * serializeFilterGroup({ and: [
 *   { field: 'scope', op: 'is', value: 'global' },
 *   { or: [ { field: 'key', op: 'contains', value: 'auth' } ] },
 * ]});
 * // → ['scope.eq.global', 'key.ilike.%auth%']
 */
export function serializeFilterGroup(filter: FilterGroup | undefined): string[] {
  if (!filter) return [];

  if ('and' in filter) {
    // AND: each child becomes its own conjunct, so recurse and concatenate.
    return filter.and.flatMap((child) => serializeFilterGroup(child));
  }

  // OR node or leaf: a single conjunct (possibly a comma-joined disjunction).
  const s = groupToOrString(filter);
  return s === null ? [] : [s];
}
