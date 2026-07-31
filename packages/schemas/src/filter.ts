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

/**
 * Percent-encode the characters that are structural in a PostgREST filter
 * expression. Without this a value containing `,` or `)` could terminate the
 * current clause and inject a sibling predicate.
 */
function encodeForPostgrest(val: string): string {
  return val.replace(/[(),]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Serialise a single leaf condition, or `null` if its field is not allowed. */
function conditionToString(c: FilterCondition): string | null {
  if (!ALLOWED_FILTER_FIELDS.has(c.field)) return null;
  const v = encodeForPostgrest(c.value ?? '');
  switch (c.op) {
    case 'is':               return `${c.field}.eq.${v}`;
    case 'is_not':           return `${c.field}.neq.${v}`;
    case 'contains':         return `${c.field}.ilike.%${v}%`;
    case 'does_not_contain': return `${c.field}.not.ilike.%${v}%`;
    case 'starts_with':      return `${c.field}.ilike.${v}%`;
    case 'ends_with':        return `${c.field}.ilike.%${v}`;
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
