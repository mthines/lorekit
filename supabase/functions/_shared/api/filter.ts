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

function groupToString(g: FilterGroup): string | null {
  if ('and' in g) {
    const parts = g.and.map(groupToString).filter((s): s is string => s !== null);
    if (!parts.length) return null;
    return parts.join(','); // PostgREST AND = comma-separated within an or() call
  }
  if ('or' in g) {
    const parts = g.or.map(groupToString).filter((s): s is string => s !== null);
    if (!parts.length) return null;
    return parts.join(','); // PostgREST OR within or()
  }
  return conditionToString(g as FilterCondition);
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
  const expr = groupToString(filter);
  if (!expr) return query;
  return query.or(expr);
}
