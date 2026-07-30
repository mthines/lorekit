import type { FilterCondition, FilterGroup } from '@lorekit/schemas/common';

// Whitelist of filterable fields — prevents arbitrary column injection
const ALLOWED_FIELDS = new Set(['scope', 'key', 'value', 'tags', 'source_agent', 'trigger']);

function encodeForPostgrest(val: string): string {
  // PostgREST filter values: percent-encode parens and commas
  return val.replace(/[(),]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function conditionToString(c: FilterCondition): string | null {
  if (!ALLOWED_FIELDS.has(c.field)) return null;
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
 * Serialise a FilterGroup node to a PostgREST or()-compatible string.
 * Used only for OR nodes and leaf conditions; AND nodes are handled by
 * chaining in applyGroup so they are not collapsed into a single or() call.
 * Nested AND inside an OR expression uses PostgREST `and(...)` syntax.
 */
function groupToOrString(g: FilterGroup): string | null {
  if ('and' in g) {
    // Nested AND inside an OR expression — use PostgREST and() syntax
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
 * Walk a FilterGroup tree and apply it to a Supabase/PostgREST query.
 * AND nodes are expressed as chained query-builder calls (one per child).
 * OR nodes are expressed as a single `.or(parts)` call.
 * Only fields in the ALLOWED_FIELDS whitelist are accepted.
 */
function applyGroup<Q extends { or(f: string): Q }>(query: Q, g: FilterGroup): Q {
  if ('and' in g) {
    // AND: chain each child as a separate query builder call
    return g.and.reduce((q, child) => applyGroup(q, child), query);
  }
  if ('or' in g) {
    // OR: collect child strings and pass to one .or() call
    const parts = g.or
      .map((child) => groupToOrString(child))
      .filter((s): s is string => s !== null);
    if (!parts.length) return query;
    return query.or(parts.join(','));
  }
  // Leaf condition
  const s = conditionToString(g as FilterCondition);
  if (!s) return query;
  return query.or(s);
}

/**
 * Apply a FilterGroup (OR+AND tree) to a Supabase/PostgREST query.
 * Only fields in the ALLOWED_FIELDS whitelist are accepted; unknown fields
 * are silently dropped to prevent column name injection.
 *
 * Usage:
 *   let q = db.from<MemoryRow>('memories').select('...');
 *   q = applyFilter(q, body.filter);
 */
export function applyFilter<Q extends { or(f: string): Q }>(query: Q, filter: FilterGroup | undefined): Q {
  if (!filter) return query;
  return applyGroup(query, filter);
}
