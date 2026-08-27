import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, within, waitFor } from 'storybook/test';

import { ScopeConsumption } from './ScopeConsumption';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link ScopeConsumption} — asserts the additive
 * invariant (bars sum to the headline, including the unattributed bucket) and
 * that the unattributed bucket is labelled rather than dropped.
 */
const meta: Meta<typeof ScopeConsumption> = {
  title: 'Lore/ScopeConsumption/Tests',
  component: ScopeConsumption,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  args: {
    since: '2026-07-01T00:00:00.000Z',
    until: FROZEN_NOW,
  },
};

export default meta;
type Story = StoryObj<typeof ScopeConsumption>;

const FIXTURE_BUCKETS = [
  { bucket: '2026-07-05T00:00:00.000Z', scope: 'repo::mthines/lorekit', count: 58631 },
  { bucket: '2026-07-05T00:00:00.000Z', scope: 'global', count: 110187 },
  { bucket: '2026-07-05T00:00:00.000Z', scope: 'project::lorekit-web-daily-report', count: 854 },
  { bucket: '2026-07-05T00:00:00.000Z', scope: null, count: 145260 },
];
const FIXTURE_TOTAL = FIXTURE_BUCKETS.reduce((sum, b) => sum + b.count, 0);

export const HeadlineSumsToTotalIncludingUnattributed: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({ bucket: 'day', since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW, buckets: FIXTURE_BUCKETS }),
        ),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the headline total equals the sum of every row, including the unattributed bucket', async () => {
      await waitFor(() => expect(canvas.getByText(/records read/i)).toBeVisible());
      // AnimatedNumber's sr-only node carries the exact, unabbreviated figure —
      // the house rule is to read that half, never the animated `textContent`.
      await expect(canvas.getByText(FIXTURE_TOTAL.toLocaleString('en-US'))).toBeInTheDocument();
    });
    await step('the unattributed bucket renders as its own labelled row, not dropped', async () => {
      await expect(canvas.getByText('unattributed')).toBeVisible();
      await expect(canvas.getByText((145260).toLocaleString('en-US'))).toBeVisible();
    });
  },
};

export const EmptyWindowShowsNoReadsMessage: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({ bucket: 'day', since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW, buckets: [] }),
        ),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('an empty window renders the empty-state message, not a zero-filled leaderboard', async () => {
      await waitFor(() => expect(canvas.getByText(/no memory reads recorded/i)).toBeVisible());
    });
  },
};
