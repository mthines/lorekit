import type { Meta, StoryObj } from '@storybook/react';
import { LoreUtilityGrid } from './LoreUtilityGrid';
import { memoryHandlers, utilityHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the delivered × chosen grid. The component
 * fetches over TanStack Query → `GET /memories/utility`, mocked by the shared
 * `utilityHandlers()` — whose census is DERIVED from its row fixture by the
 * real classifier, so a story can never show a count the rows contradict.
 */
const meta: Meta<typeof LoreUtilityGrid> = {
  title: 'Lore/LoreUtilityGrid',
  component: LoreUtilityGrid,
  // `appDirectory`: each row is a `next/link` into the Explorer, which needs
  // the App Router context.
  parameters: {
    layout: 'padded',
    nextjs: { appDirectory: true },
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
type Story = StoryObj<typeof LoreUtilityGrid>;

/** All five states populated — the 2×2 plus the "too new to judge" strip. */
export const Default: Story = {};

/** No lore at all: five zeroes, and no quadrant claiming rows it does not have. */
export const Empty: Story = {
  parameters: { msw: { handlers: [...utilityHandlers([]), ...memoryHandlers([])] } },
};
