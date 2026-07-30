import type { FilterGroup } from '@lorekit/schemas/common';
import { serializeFilterGroup } from '@lorekit/schemas/filter';

/**
 * Apply a FilterGroup (OR+AND tree) to a Supabase/PostgREST query.
 *
 * All of the semantics — operator mapping, the field whitelist, and value
 * encoding — live in `@lorekit/schemas`'s `serializeFilterGroup`, next to the
 * `FilterGroupSchema` that validates the input. This adapter only chains the
 * resulting expressions onto the query builder: PostgREST ANDs successive
 * `.or()` calls, so one call per conjunct reproduces the tree.
 *
 * Usage:
 *   let q = db.from<MemoryRow>('memories').select('...');
 *   q = applyFilter(q, body.filter);
 */
export function applyFilter<Q extends { or(f: string): Q }>(
  query: Q,
  filter: FilterGroup | undefined,
): Q {
  return serializeFilterGroup(filter).reduce((q, expr) => q.or(expr), query);
}
