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

const MINUTE = 60_000;
// One write + one read every minute of the last 61 days: a uniform rate, so two
// equal-length windows hold equal counts and the honest change is exactly 0%.
// (An hourly series would not do: equal windows can catch 24 vs 23 events.)
const anchor = Math.floor(Date.parse(NOW) / HOUR) * HOUR;
const lastMinute = Math.floor(Date.parse(NOW) / MINUTE) * MINUTE;
const EVENTS = Array.from({ length: 61 * 24 * 60 }, (_, i) => lastMinute - i * MINUTE);
const eventsIn = (from: string, to: string) =>
  EVENTS.filter((t) => t >= Date.parse(from) && t < Date.parse(to)).length;
// The same minutes, kept only between 09:00 and 18:00 UTC: identical days with
// a daily rhythm. A uniform rate cannot tell a comparison that keeps the time
// of day from one that does not; this fixture can.
const WORKDAY_EVENTS = EVENTS.filter((t) => {
  const hour = new Date(t).getUTCHours();
  return hour >= 9 && hour < 18;
});
let served = EVENTS;

function serve(since?: string, until?: string) {
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = until ? Date.parse(until) : Infinity;
  const perBucket = new Map<number, number>();
  for (const t of served) {
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

async function trendsFor(range: TimeRange, now = NOW) {
  const plan = bucketPlanForRange(range, now) ?? FALLBACK;
  const gridNow = gridAnchor(range, now);
  const { since, until } = statsWindow(range, now);
  const comparison = comparisonWindow(plan, gridNow, { since, until }, now);
  const data = await fetchExplorerStats(null, {}, plan.unit, since, until, comparison);
  return {
    since,
    until,
    chartStart: comparison.chartStart,
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
    const { written, read, until, chartStart } = await trendsFor({ preset: '24h' });
    expect(written.lessons.changePct).toBe(0);
    expect(written.scopes.changePct).toBe(0);
    expect(read.changePct).toBe(0);
    // The charted half still describes only the charted buckets.
    expect(sum(written.lessons.points)).toBe(eventsIn(chartStart, until));
    expect(sum(read.points)).toBe(eventsIn(chartStart, until));
  });

  it('never lets a row from before an UNALIGNED since into a charted bar', async () => {
    // 10:30→12:00 charts the 10:00 and 11:00 bars; the 10:00–10:29 events
    // precede the selection and must not reach the headline.
    const day = new Date(anchor).toISOString().slice(0, 10);
    const from = `${day}T10:30:00.000Z`;
    const to = `${day}T12:00:00.000Z`;
    const { written, read } = await trendsFor({ from, to });
    expect(sum(written.lessons.points)).toBe(eventsIn(from, to));
    expect(sum(read.points)).toBe(eventsIn(from, to));
    // …and the comparison is the same 90 minutes, so a uniform rate reads 0%.
    expect(written.lessons.changePct).toBe(0);
  });

  it('stops the comparison at now when the selection ends after it', async () => {
    // Today's heatmap cell runs to tomorrow's midnight but has rows only up to
    // now; a comparison sized by that future end read a flat account as -48%.
    const today = NOW.slice(0, 10);
    const { written, read } = await trendsFor({ from: today, to: today });
    expect(written.lessons.changePct).toBe(0);
    expect(written.scopes.changePct).toBe(0);
    expect(read.changePct).toBe(0);
  });

  it.each([
    ['today', { from: NOW.slice(0, 10), to: NOW.slice(0, 10) }],
    ['the 7d preset', { preset: '7d' }],
  ] as const)('a daily rhythm trends 0%% on %s: the comparison keeps the time of day', async (_label, range) => {
    // Today until 12:34 is compared with yesterday until 12:34. Placed directly
    // before the chart, the comparison weighed this morning against yesterday
    // afternoon and read identical days as a decline.
    served = WORKDAY_EVENTS;
    try {
      const { written, read } = await trendsFor(range);
      expect(written.lessons.changePct).toBe(0);
      expect(read.changePct).toBe(0);
    } finally {
      served = EVENTS;
    }
  });

  it.each([
    ['24h at hh:05', '2026-10-20T12:05:00.000Z', { preset: '24h' }],
    ['7d at 00:30', '2026-10-20T00:30:00.000Z', { preset: '7d' }],
    ['30d at 00:30', '2026-10-20T00:30:00.000Z', { preset: '30d' }],
  ] as const)('a uniform rate trends 0%% end-to-end on %s', async (_label, now, range) => {
    // The charted half ends at now, mid-bucket; a comparison a whole bucket
    // longer would read a flat account as a decline (-4% to -14% here).
    const { written, read } = await trendsFor(range, now);
    expect(written.lessons.changePct).toBe(0);
    expect(written.scopes.changePct).toBe(0);
    expect(read.changePct).toBe(0);
  });

  it('keeps the account-wide usage summary on the SELECTED window', async () => {
    const { since } = await trendsFor({ preset: '24h' });
    expect(requested.usage).toBe(since);
  });
});
