/**
 * Regression: every Explorer stat-card trend chip read "+100%".
 *
 * `computeRangeTrends` / `computeCountTrend` compare the charted window against
 * the equal-length window BEFORE it, so the rows they are handed must cover
 * both. The fetch only asked the server for the charted window, the comparison
 * half was always empty, and `pctChange(n, 0)` is +100% for any n > 0.
 *
 * The fake server mirrors the RPCs: it filters raw events by `created_at`
 * against `[since, until)` and only THEN truncates to the bucket, so a fetch
 * that reaches past an unaligned `since` would be caught leaking into a bar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { comparisonWindow, computeCountTrend, computeRangeTrends } from '@/lib/aggregations';
import { bucketPlanForRange, gridAnchor, type TimeRange } from '@/lib/time-range';

const HOUR = 3_600_000;
const NOW = '2026-10-20T12:34:56.000Z';
const FALLBACK = { unit: 'hour' as const, count: 24 };

// One write + one read at :10 past every hour of the last 72h: a flat series,
// so the honest period-over-period change is exactly 0%.
const anchor = Math.floor(Date.parse(NOW) / HOUR) * HOUR;
const EVENTS = Array.from({ length: 72 }, (_, i) => anchor - i * HOUR + 10 * 60_000);

function serve(since?: string, until?: string) {
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = until ? Date.parse(until) : Infinity;
  const perBucket = new Map<number, number>();
  for (const t of EVENTS) {
    if (t < lo || t >= hi) continue;
    const b = Math.floor(t / HOUR) * HOUR;
    perBucket.set(b, (perBucket.get(b) ?? 0) + 1);
  }
  return [...perBucket].map(([b, count]) => ({ bucket: new Date(b).toISOString(), count }));
}

const requested: { usage?: string } = {};

vi.mock('@/lib/api/session-browser', () => ({ browserAccessToken: async () => 'token' }));
vi.mock('@/lib/api/memories', () => ({
  activityPostRequest: async (_t: string, q: { since?: string; until?: string; bucket: string }) => ({
    ...q,
    buckets: serve(q.since, q.until).map((b) => ({ ...b, scope: 'global' })),
  }),
  readActivityRequest: async (_t: string, q: { since?: string; until?: string; bucket: string }) => ({
    ...q,
    buckets: serve(q.since, q.until).map((b) => ({ ...b, scope: 'global', read_kind: 'bulk' as const })),
  }),
  usageRequest: async (_t: string, q: { since?: string }) => {
    requested.usage = q.since;
    return { summary: { archived: 0, expired: 0 } };
  },
}));

const { fetchExplorerStats, statsWindow } = await import('./explorer-stats');

async function trendsFor(range: TimeRange) {
  const plan = bucketPlanForRange(range, NOW) ?? FALLBACK;
  const gridNow = gridAnchor(range, NOW);
  const { since, until } = statsWindow(range, NOW);
  const data = await fetchExplorerStats(null, {}, plan.unit, since, until, comparisonWindow(plan, gridNow));
  return {
    since,
    written: computeRangeTrends(data.rows, gridNow, plan),
    read: computeCountTrend(data.readBuckets, gridNow, plan),
  };
}

const sum = (points: { value: number }[]) => points.reduce((a, p) => a + p.value, 0);

describe('Explorer stat trends compare against a FETCHED preceding period', () => {
  beforeEach(() => {
    delete requested.usage;
  });

  it('a flat 24h series trends 0%, not +100%', async () => {
    const { written, read } = await trendsFor({ preset: '24h' });
    expect(written.lessons.changePct).toBe(0);
    expect(written.scopes.changePct).toBe(0);
    expect(read.changePct).toBe(0);
    // The charted half still describes only the selected window.
    expect(sum(written.lessons.points)).toBe(24);
    expect(sum(read.points)).toBe(24);
  });

  it('never lets a row from before an UNALIGNED since into a charted bar', async () => {
    // 10:30→12:00 charts the 10:00 and 11:00 bars. The 10:10 event precedes the
    // selection, so the headline must count only the 11:10 one.
    const day = new Date(anchor).toISOString().slice(0, 10);
    const { written, read } = await trendsFor({ from: `${day}T10:30:00.000Z`, to: `${day}T12:00:00.000Z` });
    expect(sum(written.lessons.points)).toBe(1);
    expect(sum(read.points)).toBe(1);
  });

  it('keeps the account-wide usage summary on the SELECTED window', async () => {
    const { since } = await trendsFor({ preset: '24h' });
    expect(requested.usage).toBe(since);
  });
});
