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

// ── Stat-card trend series (dashboard sparkbars) ──────────────────────────────

/** A row needed for trend computation. */
export interface TrendRow {
  scope: string;
  created_at: string; // UTC ISO
}

/** One bar in a sparkbar: a display-ready label + numeric value. */
export interface BucketPoint {
  label: string;
  value: number;
}

/** A metric's trend: its bucketed series + a period-over-period % change. */
export interface StatTrend {
  points: BucketPoint[];
  /** Percentage change of the recent window vs. the preceding window. */
  changePct: number;
}

export interface StatTrends {
  /** Lessons written per day, last 30 days. */
  lessons: StatTrend;
  /** Distinct scopes active per day, last 30 days. */
  scopes: StatTrend;
  /** Lessons written per hour, last 24 hours. */
  activity: StatTrend;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Rounded percentage change of `recent` vs `prev`. Growth from zero → +100%. */
export function pctChange(recent: number, prev: number): number {
  if (prev === 0) return recent === 0 ? 0 : 100;
  return Math.round(((recent - prev) / prev) * 100);
}

/** % change of the sum of the last `k` values vs. the preceding `k` values. */
export function windowChange(values: number[], k: number): number {
  const n = values.length;
  const recent = values.slice(Math.max(0, n - k)).reduce((a, b) => a + b, 0);
  const prev = values
    .slice(Math.max(0, n - 2 * k), Math.max(0, n - k))
    .reduce((a, b) => a + b, 0);
  return pctChange(recent, prev);
}

/**
 * % change of distinct scopes active in the last `k` days vs. the preceding
 * `k` days.
 *
 * Unlike lessons, scopes must be counted distinctly per window — summing daily
 * distinct-scope counts double-counts a scope that was active on multiple days
 * within the window.
 *
 * `buckets` is the array of per-day scope sets aligned oldest→newest (one
 * entry per day). The function reads the last `k` entries as "recent" and the
 * preceding `k` as "prev", unions each half's sets, then compares sizes.
 */
export function scopeWindowChange(buckets: Set<string>[], k: number): number {
  const n = buckets.length;
  const recentBuckets = buckets.slice(Math.max(0, n - k));
  const prevBuckets = buckets.slice(Math.max(0, n - 2 * k), Math.max(0, n - k));
  const union = (sets: Set<string>[]) => {
    const out = new Set<string>();
    for (const s of sets) for (const v of s) out.add(v);
    return out;
  };
  return pctChange(union(recentBuckets).size, union(prevBuckets).size);
}

/**
 * Build the three dashboard stat-card trend series, each in its own bucket
 * granularity (all UTC-aligned, oldest → newest):
 *
 * - `lessons`  — lessons written per day, last 30 days.
 * - `scopes`   — distinct scopes active per day, last 30 days.
 * - `activity` — lessons written per hour, last 24 hours.
 *
 * Each carries a `changePct`: day series compare the last 7 days vs. the prior
 * 7; the hourly series compares the last 12 hours vs. the prior 12.
 *
 * `nowIso` is injected rather than read from the clock so the function is pure
 * and deterministic for tests.
 */
export function computeStatTrends(rows: TrendRow[], nowIso: string): StatTrends {
  const now = Date.parse(nowIso);
  const parsed = rows.map((r) => ({ t: Date.parse(r.created_at), scope: r.scope }));

  // ── Daily buckets: last 30 days, UTC-day aligned. ──
  const DAYS = 30;
  const nowDate = new Date(now);
  const todayMidnight = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const lessonsPerDay: BucketPoint[] = [];
  const scopesPerDay: BucketPoint[] = [];
  // Retain the raw per-day scope sets for window-distinct changePct (see scopeWindowChange).
  const scopeSetsPerDay: Set<string>[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const start = todayMidnight - i * DAY_MS;
    const end = start + DAY_MS;
    let count = 0;
    const seen = new Set<string>();
    for (const p of parsed) {
      if (p.t >= start && p.t < end) {
        count++;
        seen.add(p.scope);
      }
    }
    const label = new Date(start).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    lessonsPerDay.push({ label, value: count });
    scopesPerDay.push({ label, value: seen.size });
    scopeSetsPerDay.push(seen);
  }

  // ── Hourly buckets: last 24 hours, UTC-hour aligned. ──
  const HOURS = 24;
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const lessonsPerHour: BucketPoint[] = [];
  for (let i = HOURS - 1; i >= 0; i--) {
    const start = thisHour - i * HOUR_MS;
    const end = start + HOUR_MS;
    let count = 0;
    for (const p of parsed) if (p.t >= start && p.t < end) count++;
    const label = `${String(new Date(start).getUTCHours()).padStart(2, '0')}:00`;
    lessonsPerHour.push({ label, value: count });
  }

  return {
    lessons: { points: lessonsPerDay, changePct: windowChange(lessonsPerDay.map((p) => p.value), 7) },
    // Use window-distinct scope counts: summing daily distinct-scope values
    // double-counts a scope active on multiple days within the same window.
    scopes: { points: scopesPerDay, changePct: scopeWindowChange(scopeSetsPerDay, 7) },
    activity: { points: lessonsPerHour, changePct: windowChange(lessonsPerHour.map((p) => p.value), 12) },
  };
}
