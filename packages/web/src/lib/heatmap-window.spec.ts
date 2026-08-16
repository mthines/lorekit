import { describe, expect, it } from 'vitest';

import {
  HEATMAP_FETCH_DAYS,
  HEATMAP_WEEKS,
  MAX_HEATMAP_WEEKS,
  heatmapSince,
} from './heatmap-window';

const DAY_MS = 86_400_000;

/**
 * The regression these guard is a chart that renders empty cells for periods
 * nobody asked the server about — indistinguishable, to a reader, from "no
 * memories were written then". So the assertions are about the fetch COVERING
 * the render, not about either number's exact value.
 */
describe('heatmap window', () => {
  it('fetches at least as far back as the widest rendered span', () => {
    expect(HEATMAP_FETCH_DAYS).toBeGreaterThanOrEqual(MAX_HEATMAP_WEEKS * 7);
  });

  it('covers the oldest cell the grid can anchor, which precedes weeks*7', () => {
    // The grid starts at the current week's Monday — up to 6 days before today
    // — and walks back `weeks - 1` weeks, so the earliest cell is
    // `6 + (weeks - 1) * 7` days old. A fetch sized at exactly `weeks * 7`
    // would clip it whenever today is late in the week.
    const oldestCellAgeDays = 6 + (MAX_HEATMAP_WEEKS - 1) * 7;
    expect(HEATMAP_FETCH_DAYS).toBeGreaterThan(oldestCellAgeDays);
  });

  it('covers every breakpoint, not just the widest', () => {
    for (const weeks of Object.values(HEATMAP_WEEKS)) {
      expect(HEATMAP_FETCH_DAYS).toBeGreaterThanOrEqual(weeks * 7);
    }
  });

  it('resolves `since` as an ISO instant that many days before the clock', () => {
    const now = '2026-06-15T12:00:00.000Z';
    const since = heatmapSince(now);
    expect(Date.parse(now) - Date.parse(since)).toBe(HEATMAP_FETCH_DAYS * DAY_MS);
    expect(since).toBe(new Date(since).toISOString());
  });

  it('is injected, not read from the ambient clock', () => {
    // Two different instants must produce two different bounds — a function
    // that ignored its argument would pass every assertion above.
    expect(heatmapSince('2026-06-15T12:00:00.000Z')).not.toBe(
      heatmapSince('2026-07-15T12:00:00.000Z'),
    );
  });

  it('asks for more than the server default only because the render needs it', () => {
    // `GET /memories/activity` falls back to 200 days when `since` is absent.
    // This test exists to make the coupling visible: if the desktop span ever
    // drops back under that, the explicit `since` becomes optional again.
    const SERVER_DEFAULT_WINDOW_DAYS = 200;
    expect(MAX_HEATMAP_WEEKS * 7).toBeGreaterThan(SERVER_DEFAULT_WINDOW_DAYS);
  });
});
