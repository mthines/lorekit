/**
 * Regression: every Explorer stat-card trend chip read "+100%".
 *
 * `computeRangeTrends` / `computeCountTrend` compare the charted window against
 * the equal-length window BEFORE it, so the rows they are handed must cover
 * both. The fetch only asked the server for the charted window, the comparison
 * half was always empty, and `pctChange(n, 0)` is +100% for any n > 0.
 *
 * The fake server here honours `since`/`until` exactly as the RPCs do, so the
 * test fails for the real reason — the preceding period was never fetched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActivityBucket, ReadActivityBucket } from '@lorekit/schemas/memory';
import { computeCountTrend, computeRangeTrends } from '@/lib/aggregations';
import { bucketPlanForRange, gridAnchor, type TimeRange } from '@/lib/time-range';

const HOUR = 3_600_000;
const NOW = '2026-10-20T12:34:56.000Z';

// One write + one read in EVERY hour of the last 72h: a flat series, so the
// honest period-over-period change is exactly 0%.
const anchor = Math.floor(Date.parse(NOW) / HOUR) * HOUR;
const hours = Array.from({ length: 72 }, (_, i) => new Date(anchor - i * HOUR).toISOString());
const ACTIVITY: ActivityBucket[] = hours.map((bucket) => ({ bucket, scope: 'global', count: 1 }));
const READS: ReadActivityBucket[] = hours.map((bucket) => ({
  bucket,
  scope: 'global',
  read_kind: 'bulk',
  count: 1,
}));

const inWindow = (bucket: string, since?: string, until?: string) => {
  const t = Date.parse(bucket);
  return (!since || t >= Date.parse(since)) && (!until || t < Date.parse(until));
};

const requested: { activity?: string; read?: string; usage?: string } = {};

vi.mock('@/lib/api/session-browser', () => ({ browserAccessToken: async () => 'token' }));
vi.mock('@/lib/api/memories', () => ({
  activityPostRequest: async (_t: string, body: { since?: string; until?: string; bucket: string }) => {
    requested.activity = body.since;
    return { bucket: body.bucket, since: body.since, until: body.until, buckets: ACTIVITY.filter((b) => inWindow(b.bucket, body.since, body.until)) };
  },
  readActivityRequest: async (_t: string, q: { since?: string; until?: string; bucket: string }) => {
    requested.read = q.since;
    return { bucket: q.bucket, since: q.since, until: q.until, buckets: READS.filter((b) => inWindow(b.bucket, q.since, q.until)) };
  },
  usageRequest: async (_t: string, q: { since?: string }) => {
    requested.usage = q.since;
    return { summary: { archived: 0, expired: 0 } };
  },
}));

const { fetchExplorerStats, statsWindow } = await import('./explorer-stats');

describe('Explorer stat trends compare against a FETCHED preceding period', () => {
  beforeEach(() => {
    delete requested.activity;
    delete requested.read;
    delete requested.usage;
  });

  it('a flat 24h series trends 0%, not +100%', async () => {
    const range: TimeRange = { preset: '24h' };
    const plan = bucketPlanForRange(range, NOW) ?? { unit: 'hour' as const, count: 24 };
    const { since, until } = statsWindow(range, NOW);
    const data = await fetchExplorerStats(null, {}, plan.unit, since, until);
    const gridNow = gridAnchor(range, NOW);

    const written = computeRangeTrends(data.rows, gridNow, plan);
    const read = computeCountTrend(data.readBuckets, gridNow, plan);

    expect(written.lessons.changePct).toBe(0);
    expect(written.scopes.changePct).toBe(0);
    expect(read.changePct).toBe(0);
    // The charted half still describes only the selected window.
    expect(written.lessons.points.reduce((a, p) => a + p.value, 0)).toBe(24);
  });

  it('keeps the account-wide usage summary on the SELECTED window', async () => {
    const range: TimeRange = { preset: '24h' };
    const { since, until } = statsWindow(range, NOW);
    await fetchExplorerStats(null, {}, 'hour', since, until);
    expect(requested.usage).toBe(since);
    // …while both series reach one full window further back.
    const span = Date.parse(until) - Date.parse(since);
    expect(requested.activity).toBe(new Date(Date.parse(since) - span).toISOString());
    expect(requested.read).toBe(requested.activity);
  });
});
