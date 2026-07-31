import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';

import LorePage from './page';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock, withMemorySidebar } from '@/mocks/decorators';

/**
 * Interaction tests for the `/lore` page — asserts the page resolves against the
 * MSW-mocked data and the scope/time view-mode tabs are a working tablist.
 * `/Tests` namespace, `test`-tagged, `chromatic.disableSnapshot` so the visual
 * `afterEach` skips these while the `play` functions run in the browser.
 */
const meta: Meta<typeof LorePage> = {
  title: 'Pages/Lore Explorer/Tests',
  component: LorePage,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
    // Mount the App Router context so `useRouter`/`useSearchParams` (via
    // `useUrlState`) resolve — see the note in `LorePage.stories.tsx`.
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withMemorySidebar, withQueryClient],
};

export default meta;
type Story = StoryObj<typeof LorePage>;

export const RendersScopeTree: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('The page heading renders immediately', async () => {
      await expect(
        await canvas.findByRole('heading', { name: /lore explorer/i }),
      ).toBeInTheDocument();
    });

    await step('The MSW-mocked scope tree resolves', async () => {
      // The "All scopes" row is rendered once the scope-tree query settles.
      await expect(await canvas.findByText(/all scopes/i)).toBeInTheDocument();
    });
  },
};

export const SwitchesViewMode: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: /lore explorer/i });

    const tablist = await canvas.findByRole('tablist', { name: /explorer view/i });
    const tabs = within(tablist);

    await step('Browse by scope is selected by default', async () => {
      await expect(tabs.getByRole('tab', { name: /browse by scope/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await step('Selecting Browse by time switches the active tab', async () => {
      await userEvent.click(tabs.getByRole('tab', { name: /browse by time/i }));
      await expect(tabs.getByRole('tab', { name: /browse by time/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  },
};
