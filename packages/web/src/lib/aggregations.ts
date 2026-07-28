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

/** Selectable time range for a stat card's chart + trend. */
export type MetricRange = '24h' | '7d' | '30d';

/** Bucket granularity + count charted for each selectable range. */
export const RANGE_BUCKETS: Record<MetricRange, { unit: 'hour' | 'day'; count: number }> = {
  '24h': { unit: 'hour', count: 24 },
  '7d': { unit: 'day', count: 7 },
  '30d': { unit: 'day', count: 30 },
};

/**
 * A metric's trends for one selected range. `points` cover exactly the charted
 * (recent) window, and each `changePct` compares that window against the
 * immediately preceding equal-length window — so the sparkbar and the trend chip
 * always describe the same period (no chart-vs-trend discrepancy).
 */
export interface RangeTrends {
  /** Memories written per bucket across the selected range. */
  lessons: StatTrend;
  /** Distinct scopes active per bucket across the selected range. */
  scopes: StatTrend;
  /** Distinct scopes active anywhere within the selected range window. */
  activeScopes: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Rounded percentage change of `recent` vs `prev`. Growth from zero → +100%. */
export function pctChange(recent: number, prev: number): number {
  if (prev === 0) return recent === 0 ? 0 : 100;
  return Math.round(((recent - prev) / prev) * 100);
}

/** Unions an array of Sets into a single Set. */
function unionSets<T>(sets: Set<T>[]): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
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
 * `buckets` is the array of per-day scope sets aligned oldest→newest (one entry
 * per day). Unions each `k`-day half separately, then compares distinct counts.
 */
export function scopeWindowChange(buckets: Set<string>[], k: number): number {
  const n = buckets.length;
  return pctChange(
    unionSets(buckets.slice(Math.max(0, n - k))).size,
    unionSets(buckets.slice(Math.max(0, n - 2 * k), Math.max(0, n - k))).size,
  );
}

/** Start-of-bucket anchor (UTC) for the bucket containing `now`. */
function bucketAnchor(now: number, unit: 'hour' | 'day'): number {
  if (unit === 'hour') return Math.floor(now / HOUR_MS) * HOUR_MS;
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Display label for a bucket start (UTC): "HH:00" for hours, "Mon D" for days. */
function bucketLabel(start: number, unit: 'hour' | 'day'): string {
  if (unit === 'hour') return `${String(new Date(start).getUTCHours()).padStart(2, '0')}:00`;
  return new Date(start).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Build a stat card's trends for a selected range, all UTC-aligned oldest→newest.
 *
 * The range picks the bucket granularity and count (see `RANGE_BUCKETS`): 24h →
 * 24 hourly buckets, 7d → 7 daily, 30d → 30 daily. To compute a period-over-period
 * `changePct` without a second query, `2 × count` buckets are tallied and only the
 * recent `count` are charted; the preceding `count` form the comparison window.
 * This keeps the sparkbar window identical to the trend window — the two can no
 * longer disagree.
 *
 * `nowIso` is injected rather than read from the clock so the function is pure
 * and deterministic for tests.
 */
export function computeRangeTrends(
  rows: TrendRow[],
  nowIso: string,
  range: MetricRange,
): RangeTrends {
  const { unit, count } = RANGE_BUCKETS[range];
  const unitMs = unit === 'hour' ? HOUR_MS : DAY_MS;
  const now = Date.parse(nowIso);
  const parsed = rows.map((r) => ({ t: Date.parse(r.created_at), scope: r.scope }));
  const anchor = bucketAnchor(now, unit);

  // 2 × count buckets: chart the recent half, compare against the prior half.
  const total = count * 2;
  const lessonsAll: BucketPoint[] = [];
  const scopesAll: BucketPoint[] = [];
  const scopeSetsAll: Set<string>[] = [];
  for (let i = total - 1; i >= 0; i--) {
    const start = anchor - i * unitMs;
    const end = start + unitMs;
    let c = 0;
    const seen = new Set<string>();
    for (const p of parsed) {
      if (p.t >= start && p.t < end) {
        c++;
        seen.add(p.scope);
      }
    }
    const label = bucketLabel(start, unit);
    lessonsAll.push({ label, value: c });
    scopesAll.push({ label, value: seen.size });
    scopeSetsAll.push(seen);
  }

  return {
    lessons: {
      points: lessonsAll.slice(count),
      changePct: windowChange(lessonsAll.map((p) => p.value), count),
    },
    // Window-distinct scope counts: summing per-bucket distinct values would
    // double-count a scope active in multiple buckets within the same window.
    scopes: {
      points: scopesAll.slice(count),
      changePct: scopeWindowChange(scopeSetsAll, count),
    },
    activeScopes: unionSets(scopeSetsAll.slice(count)).size,
  };
}
