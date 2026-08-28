/**
 * Scope consumption — ranking scopes by how many memory RECORDS were read from
 * them, from the SAME `(bucket, scope, count)` rows `GET /memories/read-activity`
 * already returns (migration 00058). The Explorer and Overview read cards sum
 * the scope axis away and chart only the total; this ranks it instead.
 *
 * Pure and dependency-free, so it is unit-testable without a network call.
 */

import type { ReadActivityBucket } from '@lorekit/schemas/memory';

/** One ranked scope: its total records read over the queried window. */
export interface ScopeConsumptionRow {
  /** `null` is the UNATTRIBUTED bucket — see the module docblock on why it exists. */
  scope: string | null;
  count: number;
}

export interface ScopeConsumption {
  /** Ranked descending by `count`; ties keep the input's relative order (stable sort). */
  rows: ScopeConsumptionRow[];
  /**
   * Sum of every row, INCLUDING the unattributed bucket. Bars must sum to this
   * number — dropping the unattributed bucket from `rows` while keeping it in
   * `total` would break that invariant, so this is always
   * `rows.reduce((n, r) => n + r.count, 0)` by construction.
   */
  total: number;
}

/**
 * Sum `(bucket, scope, count)` rows onto one ranked-by-scope list.
 *
 * The `null` scope is a real bucket, not an omission: as of this write it is
 * ~40% of all read records account-wide, overwhelmingly `memory.search` (which
 * takes a `scopes[]` array — `usage_events.scope` is one column and cannot
 * record it; see PR B2). It is kept in `rows` with `scope: null` — never
 * dropped — so a caller that renders every row reproduces `total` exactly, and
 * a caller that drops it can no longer claim the two agree.
 */
export function rankScopeConsumption(buckets: readonly ReadActivityBucket[]): ScopeConsumption {
  const totals = new Map<string | null, number>();
  for (const bucket of buckets) {
    totals.set(bucket.scope, (totals.get(bucket.scope) ?? 0) + bucket.count);
  }

  const rows = [...totals.entries()]
    .map(([scope, count]) => ({ scope, count }))
    .sort((a, b) => b.count - a.count);

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, total };
}
