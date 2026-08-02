import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';

import { DashboardStats } from './DashboardStats';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link DashboardStats} — asserts the stats resolve
 * against the MSW-mocked PostgREST data and the per-card range selector is a
 * working single-select radiogroup. `/Tests` namespace, `test`-tagged, and
 * `chromatic.disableSnapshot` so the visual `afterEach` skips these while the
 * `play` functions still run in the browser.
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

    await step('Scope-health data resolves from the MSW-mocked query', async () => {
      // The card label appears only after the query settles — findBy waits for it.
      await expect(await canvas.findByText('Memories written')).toBeInTheDocument();
      await expect(canvas.getByText('Scopes')).toBeInTheDocument();
    });
  },
};

export const RangeSelectorSwitches: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Memories written');

    const totalRange = await canvas.findByRole('radiogroup', {
      name: /time range for memories written/i,
    });
    const group = within(totalRange);

    await step('7d is the default range for Memories written', async () => {
      await expect(group.getByRole('radio', { name: '7d' })).toBeChecked();
    });

    await step('Selecting 30d moves the checked state', async () => {
      await userEvent.click(group.getByRole('radio', { name: '30d' }));
      await expect(group.getByRole('radio', { name: '30d' })).toBeChecked();
      await expect(group.getByRole('radio', { name: '7d' })).not.toBeChecked();
    });
  },
};
