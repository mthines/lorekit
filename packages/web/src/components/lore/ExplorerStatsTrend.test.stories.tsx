import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, waitFor, within } from 'storybook/test';

import { ExplorerInsights } from './ExplorerInsights';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import { NO_RETENTION_CONDITIONS } from '@/lib/retention-filter';

/**
 * Regression: every Activity-panel trend chip read "+100%".
 *
 * The chip compares the charted window against the equal-length period before
 * it, but the header only fetched the charted window, so the comparison half was
 * always empty and growth-from-zero printed +100% on every card at every range.
 *
 * The default MSW handlers ignore `since`/`until`, which is exactly why no story
 * caught it. These handlers honour the window the way the RPCs do (rows are
 * filtered by time, then bucketed) and serve a UNIFORM rate — one write and one
 * read per minute — so the only honest trend is 0%.
 */
const MINUTE = 60_000;
const UNIT_MS = { hour: 3_600_000, day: 86_400_000 } as const;
const HISTORY_START = Date.parse(FROZEN_NOW) - 120 * UNIT_MS.day;

function uniformBuckets(unit: 'hour' | 'day', since?: string | null, until?: string | null) {
  const lo = Math.max(HISTORY_START, since ? Date.parse(since) : HISTORY_START);
  const hi = Math.min(Date.parse(FROZEN_NOW), until ? Date.parse(until) : Date.parse(FROZEN_NOW));
  const step = UNIT_MS[unit];
  const out: { bucket: string; count: number }[] = [];
  for (let b = Math.floor(lo / step) * step; b < hi; b += step) {
    const overlap = Math.min(hi, b + step) - Math.max(lo, b);
    const count = Math.round(overlap / MINUTE);
    if (count > 0) out.push({ bucket: new Date(b).toISOString(), count });
  }
  return out;
}

const unitOf = (v: unknown) => (v === 'hour' ? 'hour' : 'day');

const uniformHandlers = [
  http.post('*/functions/v1/memories/activity', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, string | undefined>;
    const bucket = unitOf(body.bucket);
    return HttpResponse.json({
      bucket,
      since: body.since,
      until: body.until,
      buckets: uniformBuckets(bucket, body.since, body.until).map((b) => ({ ...b, scope: 'global' })),
    });
  }),
  http.get('*/functions/v1/memories/read-activity', ({ request }) => {
    const url = new URL(request.url);
    const bucket = unitOf(url.searchParams.get('bucket'));
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    return HttpResponse.json({
      bucket,
      since,
      until,
      buckets: uniformBuckets(bucket, since, until).map((b) => ({ ...b, scope: 'global', read_kind: 'bulk' })),
    });
  }),
  // Everything else (usage, scopes, auth) from the shared fixtures. MSW takes
  // the first matching handler, so the two above win.
  ...memoryHandlers(),
];

const meta: Meta<typeof ExplorerInsights> = {
  title: 'Lore/ExplorerInsights/Tests/Trend',
  component: ExplorerInsights,
  tags: ['test'],
  parameters: {
    layout: 'fullscreen',
    chromatic: { disableSnapshot: true },
    msw: { handlers: uniformHandlers },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  beforeEach: () => {
    for (const key of Object.values(PREFERENCE_KEYS)) window.localStorage.removeItem(key);
  },
  args: {
    scope: null,
    scopeLabel: 'All scopes',
    onRangeChange: () => undefined,
    filters: [],
    retention: NO_RETENTION_CONDITIONS,
    heatmapData: [],
    highlightRange: null,
    onSelectDate: () => undefined,
    nowIso: FROZEN_NOW,
  },
};

export default meta;
type Story = StoryObj<typeof ExplorerInsights>;

/** The settled headline number on the card with `label` (the counter's sr-only half). */
function headline(canvas: ReturnType<typeof within>, label: string): number {
  // The card's first paragraph is the counter; its last span is the settled
  // value (the first is the tween). Formatted with separators, e.g. "9,360".
  const counter = canvas.getByText(label).closest('[data-stat-card]')?.querySelector('p');
  const settled = counter?.querySelectorAll('span span');
  return Number(settled?.[settled.length - 1]?.textContent?.replace(/[^\d.-]/g, ''));
}

/** The trend chip's visible text on the card with `label`. */
function chipText(canvas: ReturnType<typeof within>, label: string): string | undefined {
  const card = canvas.getByText(label).closest('[data-stat-card]');
  return card?.querySelector('[title*="preceding period"]')?.textContent?.trim();
}

function flatTrendStory(preset: '24h' | '7d' | '30d'): Story {
  return {
    args: { range: { preset } },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await canvas.findByRole('button', { name: /hide activity detail/i });
      for (const label of ['Memories written', 'Memories retrieved', 'Scopes active']) {
        // Data first: an empty first render is 0 vs 0, which also reads 0%.
        await waitFor(() => expect(headline(canvas, label)).toBeGreaterThan(0));
        await expect(chipText(canvas, label)).toBe('0%');
      }
    },
  };
}

export const FlatRateTrendsZeroAt24h = flatTrendStory('24h');
export const FlatRateTrendsZeroAt7d = flatTrendStory('7d');
export const FlatRateTrendsZeroAt30d = flatTrendStory('30d');
