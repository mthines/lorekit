import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { InsightsPage } from './InsightsPage';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for `/insights`. `/Tests` namespace, `test`-tagged, and
 * `chromatic.disableSnapshot` so the visual `afterEach` skips these while the
 * `play` functions still run in the browser.
 */
function handlers() {
  // MSW resolves handlers in list order (first match wins), so the usage
  // override must come BEFORE `...memoryHandlers()` or its own (empty)
  // usage fixture always wins instead.
  return [
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json({
        range: { since: url.searchParams.get('since'), until: url.searchParams.get('until') },
        correlation_id: null,
        summary: { total_events: 10, reads: 8, writes: 2, other: 0, records_read: 40, archived: 0, expired: 0, by_outcome: { ok: 10 } },
        by_tool: [
          { tool_name: 'memory.list', outcome: 'ok', scope_type: 'global', event_count: 8, record_count: 40, total_duration_ms: 800, client: 'mcp', kind: 'lesson', host: 'claude' },
        ],
        by_scope_type: [],
      });
    }),
    http.get('*/functions/v1/memories/read-ranking', ({ request }) =>
      HttpResponse.json({
        direction: new URL(request.url).searchParams.get('direction') ?? 'cold',
        counting_since: '2026-08-23T00:00:00.000Z',
        entries: [],
      }),
    ),
    http.get('*/functions/v1/memories/usage/runs', () =>
      HttpResponse.json({ range: { since: null, until: FROZEN_NOW }, runs: [], next_cursor: null }),
    ),
    ...memoryHandlers(),
  ];
}

const meta: Meta<typeof InsightsPage> = {
  title: 'Pages/Insights/Tests',
  component: InsightsPage,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'fullscreen',
    msw: { handlers: handlers() },
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof InsightsPage>;

export const RendersAllFiveSections: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the page title and all five section headings render', async () => {
      await expect(canvas.getByRole('heading', { name: 'Insights', level: 1 })).toBeInTheDocument();
      for (const heading of [
        'Operational health',
        "Who's reading",
        'Scope consumption',
        'Hot & cold lore',
        'Runs',
      ]) {
        await waitFor(() => expect(canvas.getByRole('heading', { name: heading })).toBeInTheDocument());
      }
    });
  },
};

export const ScopeConsumptionHasItsOwnRangePicker: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('exactly one range picker exists, scoped to Scope consumption', async () => {
      await waitFor(() =>
        expect(canvas.getAllByRole('radiogroup', { name: /time range/i })).toHaveLength(1),
      );
    });
  },
};
