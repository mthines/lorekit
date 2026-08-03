import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';

import { DashboardStats } from './DashboardStats';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link DashboardStats} — asserts the three cards
 * resolve against the MSW-mocked REST data and that the ONE shared range
 * selector is a working single-select radiogroup driving all of them.
 * `/Tests` namespace, `test`-tagged, and `chromatic.disableSnapshot` so the
 * visual `afterEach` skips these while the `play` functions still run in the
 * browser.
 */
const meta: Meta<typeof DashboardStats> = {
  title: 'Pages/Dashboard Stats/Tests',
  component: DashboardStats,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DashboardStats>;

export const LoadsMockedStats: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('All three metric cards resolve from the MSW-mocked queries', async () => {
      // The card label appears only after the query settles — findBy waits for it.
      await expect(await canvas.findByText('Memories written')).toBeInTheDocument();
      await expect(canvas.getByText('Scopes')).toBeInTheDocument();
      await expect(canvas.getByText('Memories read')).toBeInTheDocument();
    });

    await step('Each card declares the unit AND the verb it counts', async () => {
      // "writes" alone would not say writes of WHAT — and the Scopes card
      // counts scopes written to, not memories.
      await expect(canvas.getByText('Memory writes')).toBeInTheDocument();
      await expect(canvas.getByText('Memory reads')).toBeInTheDocument();
      await expect(canvas.getByText('Scopes writes')).toBeInTheDocument();
    });

    await step('The two memory cards are adjacent, scopes last', async () => {
      // Read the order off the unit tags: the card LABEL shares its element
      // with the tooltip copy, so its textContent is the label plus a
      // paragraph of prose.
      const order = canvas
        .getAllByText(/^(Memory writes|Memory reads|Scopes writes)$/)
        .map((el) => el.textContent?.trim());
      await expect(order).toEqual(['Memory writes', 'Memory reads', 'Scopes writes']);
    });
  },
};

export const RangeSelectorSwitches: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Memories written');

    const groups = await canvas.findAllByRole('radiogroup', { name: /time range/i });
    const group = within(groups[0]);

    await step('There is exactly one shared range picker, not one per card', async () => {
      await expect(groups).toHaveLength(1);
    });

    await step('24h is the default range', async () => {
      await expect(group.getByRole('radio', { name: '24h' })).toBeChecked();
    });

    await step('Selecting 30d moves the checked state', async () => {
      await userEvent.click(group.getByRole('radio', { name: '30d' }));
      await expect(group.getByRole('radio', { name: '30d' })).toBeChecked();
      await expect(group.getByRole('radio', { name: '24h' })).not.toBeChecked();
    });

    await step('The shared range re-labels every card', async () => {
      const descriptions = await canvas.findAllByText(/in the last 30 days/i);
      await expect(descriptions.length).toBeGreaterThanOrEqual(2);
      await expect(
        canvas.getByText(/distinct scopes active in the last 30 days/i),
      ).toBeInTheDocument();
    });
  },
};
