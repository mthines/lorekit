/**
 * Pure aggregation helpers for the dashboard and activity views.
 *
 * The rollups that used to live here (per-scope totals, per-day counts over raw
 * rows) moved into Postgres behind `GET /memories/scopes` and
 * `GET /memories/activity` — a browser-side rollup over a capped row set is
 * silently wrong past that cap. What remains is the pure shaping of those
 * responses plus the stat-card trend maths, all unit-testable without Supabase
 * or TanStack.
 */

/** A per-calendar-day (UTC) count, as the contribution heatmap renders it. */
export interface DayCount {
  date: string; // YYYY-MM-DD
  count: number;
}

// ── GET /memories/activity → the shapes the stat cards and heatmap consume ──

/**
 * One `(bucket, scope, count)` cell from `GET /memories/activity`: memories
 * created in that UTC hour/day under that scope.
 */
export interface ActivityBucketRow {
  /** UTC start of the interval, ISO. */
  bucket: string;
  scope: string;
  count: number;
}

/**
 * Roll activity buckets up into per-calendar-day counts (UTC) for the
 * contribution heatmap.
 *
 * Works for either granularity: hour buckets collapse into their day because
 * the date prefix is all that is read. Returned sorted by date ascending — the
 * heatmap renders the array in order, so the sort is part of the contract.
 */
export function dayCountsFromActivity(rows: readonly ActivityBucketRow[]): DayCount[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const day = row.bucket.slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + row.count);
  }
  return Array.from(map.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Expand activity buckets back into the one-row-per-memory shape
 * {@link computeRangeTrends} takes.
 *
 * This is lossless for every question that function asks. It buckets by UTC
 * hour or day, and `date_trunc` on the server anchors each bucket at exactly
 * those boundaries, so `count` rows placed at the bucket start fall in the same
 * bucket the original timestamps did — and `scope` is carried per cell, so the
 * distinct-scope counts are unaffected too. What is deliberately NOT preserved
 * is sub-bucket precision, which no trend or sparkbar reads.
 *
 * Expanding here rather than teaching `computeRangeTrends` a second input shape
 * keeps that function — the one with the period-over-period comparison logic
 * and the tests that pin it — untouched by the move to the API.
 */
export function trendRowsFromActivity(rows: readonly ActivityBucketRow[]): TrendRow[] {
  const out: TrendRow[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      out.push({ scope: row.scope, created_at: row.bucket });
    }
  }
  return out;
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
  /**
   * NEW (first-seen) scopes per bucket across the selected range.
   *
   * The additive counterpart to {@link RangeTrends.scopes}: a scope is counted
   * in the bucket where it FIRST appears within the charted window, so the
   * series sums to exactly {@link RangeTrends.activeScopes} — the distinct
   * union. That is what makes the Scopes card's sparkbar reconcile with its
   * headline number; `scopes` (distinct-per-bucket) cannot, because a scope
   * active on three days contributes three bars and one unit of the total.
   *
   * `changePct` is deliberately the BREADTH change (`scopes.changePct`): union
   * this window vs. union the previous one. "Was I working across more areas?"
   * is the question the chip answers, and a first-seen series has no meaningful
   * period-over-period sum of its own.
   */
  newScopes: StatTrend;
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

  // New (first-seen) scopes per bucket, over the CHARTED window only. Summing
  // these equals the distinct union — see `RangeTrends.newScopes`.
  const seenInWindow = new Set<string>();
  const newScopesPoints: BucketPoint[] = scopeSetsAll.slice(count).map((set, i) => {
    let fresh = 0;
    for (const scope of set) {
      if (!seenInWindow.has(scope)) {
        seenInWindow.add(scope);
        fresh++;
      }
    }
    return { label: scopesAll[count + i].label, value: fresh };
  });

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
    newScopes: {
      points: newScopesPoints,
      changePct: scopeWindowChange(scopeSetsAll, count),
    },
    activeScopes: unionSets(scopeSetsAll.slice(count)).size,
  };
}

// ── GET /memories/read-activity → the "Memories read" card ───────────────────

/** One `(bucket, count)` cell from `GET /memories/read-activity`. */
export interface CountBucketRow {
  /** UTC start of the interval, ISO. */
  bucket: string;
  count: number;
}

/**
 * Bucket a scope-less `{ bucket, count }` series onto the selected range's grid.
 *
 * Reads have no scope dimension, so `computeRangeTrends` — which is built
 * around per-bucket scope SETS — has nothing to offer them. Expanding the
 * response into fake `TrendRow`s to reuse it would also allocate one object per
 * record read, and a busy account reads tens of thousands of records a week.
 *
 * The result is additive by construction: `points` are the raw per-bucket sums
 * over the charted window, so summing the bars gives the window total the card
 * shows. `changePct` compares that total against the immediately preceding
 * equal-length window, exactly as `computeRangeTrends` does, so the chart and
 * the chip always describe the same period. Buckets the server omitted (it
 * returns a sparse series) render as zeros rather than gaps.
 *
 * Grid alignment is shared with `computeRangeTrends` (`bucketAnchor` /
 * `bucketLabel`), so a read bar and a write bar at the same index cover exactly
 * the same hour or day.
 */
export function computeCountTrend(
  rows: readonly CountBucketRow[],
  nowIso: string,
  range: MetricRange,
): StatTrend {
  const { unit, count } = RANGE_BUCKETS[range];
  const unitMs = unit === 'hour' ? HOUR_MS : DAY_MS;
  const anchor = bucketAnchor(Date.parse(nowIso), unit);
  const total = count * 2;
  const oldest = anchor - (total - 1) * unitMs;

  // Grid oldest→newest; a row lands in the slot whose [start, start + unit) it
  // falls in, which is where the server's `date_trunc` already placed it.
  const values = new Array<number>(total).fill(0);
  for (const row of rows) {
    const t = Date.parse(row.bucket);
    if (Number.isNaN(t) || t < oldest || t >= anchor + unitMs) continue;
    values[Math.floor((t - oldest) / unitMs)] += row.count;
  }

  const points: BucketPoint[] = values
    .slice(count)
    .map((value, i) => ({ label: bucketLabel(oldest + (count + i) * unitMs, unit), value }));

  return { points, changePct: windowChange(values, count) };
}
