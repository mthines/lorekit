/**
 * Pure aggregation helpers shared between the dashboard and activity queries.
 * Extracted here so they can be unit-tested independently of Supabase/TanStack.
 */

/** A raw row returned by the memories table (dashboard projection). */
export interface MemoryRow {
  scope: string;
  created_at: string;
  updated_at?: string;
}

export interface ScopeAggregate {
  scope: string;
  total: number;
  lastActivity: string;
}

/**
 * Group an array of memory rows by scope, counting total lessons and tracking
 * the most-recent `created_at` timestamp per scope.
 *
 * Rows are processed in a single pass — O(n) with no sorting required.
 */
export function aggregateByScope(rows: MemoryRow[]): ScopeAggregate[] {
  const map = new Map<string, ScopeAggregate>();
  for (const row of rows) {
    const existing = map.get(row.scope);
    if (!existing) {
      map.set(row.scope, { scope: row.scope, total: 1, lastActivity: row.created_at });
    } else {
      existing.total++;
      if (row.created_at > existing.lastActivity) {
        existing.lastActivity = row.created_at;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    b.lastActivity.localeCompare(a.lastActivity),
  );
}

/** A raw row returned by the memories table (activity projection). */
export interface ActivityRow {
  created_at: string;
}

export interface DayCount {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * Count memory rows per calendar day (UTC).
 * Returns an array sorted by date ascending.
 */
export function aggregateByDay(rows: ActivityRow[]): DayCount[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
