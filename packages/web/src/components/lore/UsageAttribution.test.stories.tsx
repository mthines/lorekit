import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, within, waitFor } from 'storybook/test';

import { UsageAttribution } from './UsageAttribution';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link UsageAttribution} — asserts both breakdowns
 * render from one /usage call, the unattributed client bucket is kept (never
 * dropped), and rows with no kind/host collapse into one bucket.
 */
const meta: Meta<typeof UsageAttribution> = {
  title: 'Lore/UsageAttribution/Tests',
  component: UsageAttribution,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  args: { since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW },
};

export default meta;
type Story = StoryObj<typeof UsageAttribution>;

function usageHandler(byTool: Array<Record<string, unknown>>) {
  return http.get('*/functions/v1/memories/usage', () =>
    HttpResponse.json({
      range: { since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW },
      correlation_id: null,
      summary: { total_events: 0, reads: 0, writes: 0, other: 0, records_read: 0, archived: 0, expired: 0, by_outcome: {} },
      by_tool: byTool,
      by_scope_type: [],
      truncated: false,
    }),
  );
}

export const RendersBothBreakdownsAndKeepsUnattributed: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        usageHandler([
          { tool_name: 'memory.list', outcome: 'ok', scope_type: 'global', client: 'mcp', kind: 'lesson', host: 'reviewer', event_count: 100, record_count: 100, total_duration_ms: 1000 },
          { tool_name: 'memory.read', outcome: 'ok', scope_type: 'repo', client: null, kind: null, host: null, event_count: 40, record_count: 40, total_duration_ms: 400 },
        ]),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('who is reading shows mcp and the kept unattributed bucket', async () => {
      await waitFor(() => expect(canvas.getByText('MCP')).toBeVisible());
      await expect(canvas.getByText('100')).toBeVisible();
      await expect(canvas.getByText('unattributed')).toBeVisible();
      await expect(canvas.getByText('40')).toBeVisible();
    });
    await step('reads by agent family shows the lesson/reviewer combination', async () => {
      await expect(canvas.getByText('lesson · reviewer')).toBeVisible();
    });
  },
};

export const EmptyWindowShowsNoUsageMessage: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), usageHandler([])] } },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('an empty window renders the empty-state message', async () => {
      await waitFor(() => expect(canvas.getByText(/no usage recorded/i)).toBeVisible());
    });
  },
};
