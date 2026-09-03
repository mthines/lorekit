import type { Meta, StoryObj } from '@storybook/react';
import { LoreCostHeadline } from './LoreCostHeadline';
import { memoryHandlers, utilityHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the cost line that leads `/insights`. Fetches
 * `GET /memories/utility` over TanStack Query; the shared `utilityHandlers()`
 * DERIVES the cost from its row fixture, so the headline and the grid beneath
 * it are computed from one dataset rather than two hand-written ones.
 */
const meta: Meta<typeof LoreCostHeadline> = {
  title: 'Lore/LoreCostHeadline',
  component: LoreCostHeadline,
  parameters: {
    layout: 'padded',
    msw: { handlers: [...utilityHandlers(), ...memoryHandlers()] },
  },
  decorators: [
    withFrozenClock(FROZEN_NOW),
    withQueryClient,
    (Story) => (
      <div style={{ maxWidth: '48rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof LoreCostHeadline>;

/** The bill: an estimated token volume, and how little of it was chosen. */
export const Default: Story = {};

/**
 * A window with no recorded deliveries.
 *
 * Renders "no lore was delivered", never "0% deliberately fetched" — a share
 * with no denominator is not a rate, and printing one would read as a verdict
 * on lore nobody was offered.
 */
export const NothingDelivered: Story = {
  parameters: { msw: { handlers: [...utilityHandlers([]), ...memoryHandlers([])] } },
};
