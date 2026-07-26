/**
 * Thin Supabase-boundary shell — the only impure surface in `lib/pagination`.
 * Takes a supabase-js filter builder and mutates it per the pure
 * cursor/keyset/filter decisions computed elsewhere. No decision logic lives
 * here; it's a 1:1 translation of already-validated values to query-builder
 * calls, kept deliberately dumb so the pure modules stay the reuse surface.
 */

import type { KeysetCursor } from './cursor';
import { keysetOrPredicate, type KeysetColumns } from './keyset';
import type { DateRangeBounds } from './filters';

// Minimal shape of the subset of the supabase-js `PostgrestFilterBuilder` API
// this module touches — avoids a hard dependency on the generated client
// type so `apply.ts` stays testable against a lightweight fake builder.
export interface FilterBuilderLike {
  order(column: string, opts?: { ascending?: boolean }): FilterBuilderLike;
  limit(count: number): FilterBuilderLike;
  or(filters: string): FilterBuilderLike;
  in(column: string, values: readonly string[]): FilterBuilderLike;
  ilike(column: string, pattern: string): FilterBuilderLike;
  gte(column: string, value: string): FilterBuilderLike;
  lt(column: string, value: string): FilterBuilderLike;
}

/**
 * Apply the `(ts desc, id desc)` ordering, the keyset "after cursor"
 * predicate (when present), and a `pageSize + 1` fetch limit.
 */
export function applyKeyset<Q extends FilterBuilderLike>(
  q: Q,
  args: { cursor: KeysetCursor | null; pageSize: number; cols?: KeysetColumns },
): Q {
  const cols = args.cols ?? { ts: 'created_at', id: 'id' };
  let next = q.order(cols.ts, { ascending: false }).order(cols.id, { ascending: false });

  const predicate = keysetOrPredicate(args.cursor, cols);
  if (predicate) next = next.or(predicate);

  return next.limit(args.pageSize + 1) as Q;
}

export interface AuditFilterSpec {
  actions: string[];
  needle: string | null;
  bounds: DateRangeBounds;
}

/**
 * Apply the audit-log filter set: an action allow-list (`.in`), a
 * pre-escaped substring needle on `target` (`.ilike`), and the inclusive
 * `from` / half-open `to` date bounds on `created_at`. Every argument is
 * expected to already be validated/normalized by `filters.ts` — this
 * function only wires values onto the query builder.
 */
export function applyAuditFilters<Q extends FilterBuilderLike>(q: Q, spec: AuditFilterSpec): Q {
  let next: FilterBuilderLike = q;

  if (spec.actions.length > 0) next = next.in('action', spec.actions);
  if (spec.needle) next = next.ilike('target', `%${spec.needle}%`);
  if (spec.bounds.gte) next = next.gte('created_at', spec.bounds.gte);
  if (spec.bounds.lt) next = next.lt('created_at', spec.bounds.lt);

  return next as Q;
}
