import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, within, userEvent, waitFor } from 'storybook/test';

import { RunsList } from './RunsList';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link RunsList} — session-kind labelling, and the
 * expand-to-drill-down behaviour that calls `GET /memories/usage?correlation_id=`.
 */
const RUN = {
  correlation_id: 'pr:mthines/lorekit#482',
  session_kind: 'pr',
  first_seen: '2026-08-20T09:00:00.000Z',
  last_seen: '2026-08-20T09:42:00.000Z',
  read_events: 12,
  records_read: 340,
  write_events: 2,
  distinct_scopes: 3,
  total_duration_ms: 184_200,
};

function handlers() {
  return [
    ...memoryHandlers(),
    http.get('*/functions/v1/memories/usage/runs', () =>
      HttpResponse.json({ range: { since: '2026-05-20T00:00:00.000Z', until: FROZEN_NOW }, runs: [RUN], next_cursor: null }),
    ),
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json({
        range: { since: null, until: null },
        correlation_id: url.searchParams.get('correlation_id'),
        summary: { total_events: 14, reads: 12, writes: 2, other: 0, records_read: 340, archived: 0, expired: 0, by_outcome: { ok: 14 } },
        by_tool: [],
        by_scope_type: [],
      });
    }),
  ];
}

const meta: Meta<typeof RunsList> = {
  title: 'Settings/RunsList/Tests',
  component: RunsList,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded', msw: { handlers: handlers() } },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof RunsList>;

export const ShowsSessionKindAndCorrelationId: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the PR run renders its badge and correlation id', async () => {
      await waitFor(() => expect(canvas.getByText('PR automation')).toBeVisible());
      await expect(canvas.getByText('pr:mthines/lorekit#482')).toBeVisible();
    });
  },
};

export const CollapsedRowShowsStatsWithoutExpanding: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('read/record/write/scope counts are visible before the row is expanded', async () => {
      await waitFor(() => expect(canvas.getByText('pr:mthines/lorekit#482')).toBeVisible());
      await expect(canvas.getByText('12 reads')).toBeVisible();
      await expect(canvas.getByText('340 records')).toBeVisible();
      await expect(canvas.getByText('2 writes')).toBeVisible();
      await expect(canvas.getByText('3 scopes')).toBeVisible();
      // Not expanded — the drill-down-only fields are absent.
      await expect(canvas.queryByText('Read events')).not.toBeInTheDocument();
    });
  },
};

export const ExpandingARowDrillsIntoUsageForThatCorrelationId: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('pr:mthines/lorekit#482')).toBeVisible());
    await step('expanding the row shows its own read/write/scope breakdown and drill-down summary', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /pr automation/i }));
      await expect(canvas.getByText('Read events')).toBeVisible();
      await expect(canvas.getByText('340')).toBeVisible();
      await waitFor(() => expect(canvas.getByText(/consistent with/i)).toBeVisible());
      await expect(canvas.getByText(/GET \/memories\/usage\?correlation_id=pr:mthines\/lorekit#482/)).toBeVisible();
    });
  },
};

export const EmptyStateExplainsHowARunAppears: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/usage/runs', () =>
          HttpResponse.json({ range: { since: '2026-05-20T00:00:00.000Z', until: FROZEN_NOW }, runs: [], next_cursor: null }),
        ),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('an empty account explains what makes a run appear', async () => {
      await waitFor(() => expect(canvas.getByText(/no runs recorded yet/i)).toBeVisible());
      await expect(canvas.getByText('LOREKIT_CORRELATION_ID')).toBeVisible();
    });
  },
};
