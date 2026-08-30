import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';

import { DashboardStats } from './DashboardStats';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link DashboardStats} — asserts the four cards
 * (migration 00080 split "Memories read" into retrieved + opened, growing
 * this row from three) resolve against the MSW-mocked REST data and that the
 * ONE shared range selector is a working single-select driving all of them.
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
    // The range selector is URL-backed (`useUrlState` → `useRouter` /
    // `usePathname` / `useSearchParams`), so the story has to provide
    // `@storybook/nextjs-vite`'s App Router context or those hooks throw
    // "invariant expected app router to be mounted" before a single card
    // renders. The mocked router's `replace` is a spy that never actually
    // changes `useSearchParams()`, which is exactly why `useUrlState`'s
    // optimistic layer is what keeps the checked state moving here.
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DashboardStats>;

export const LoadsMockedStats: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('All four metric cards resolve from the MSW-mocked queries', async () => {
      // The card label appears only after the query settles — findBy waits for it.
      await expect(await canvas.findByText('Memories written')).toBeInTheDocument();
      await expect(canvas.getByText('Scopes')).toBeInTheDocument();
      await expect(canvas.getByText('Memories retrieved')).toBeInTheDocument();
      await expect(canvas.getByText('Memories opened')).toBeInTheDocument();
    });

    await step('Each card declares the unit AND the verb it counts', async () => {
      // "writes" alone would not say writes of WHAT — and the Scopes card
      // counts scopes written to, not memories.
      await expect(canvas.getByText('Memory writes')).toBeInTheDocument();
      await expect(canvas.getByText('Bulk reads')).toBeInTheDocument();
      await expect(canvas.getByText('Targeted reads')).toBeInTheDocument();
      await expect(canvas.getByText('Scopes writes')).toBeInTheDocument();
    });

    await step('The three memory cards are adjacent, scopes last', async () => {
      // Read the order off the unit tags: the card LABEL shares its element
      // with the tooltip copy, so its textContent is the label plus a
      // paragraph of prose.
      const order = canvas
        .getAllByText(/^(Memory writes|Bulk reads|Targeted reads|Scopes writes)$/)
        .map((el) => el.textContent?.trim());
      await expect(order).toEqual(['Memory writes', 'Bulk reads', 'Targeted reads', 'Scopes writes']);
    });
  },
};

export const RangeSelectorSwitches: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Memories written');

    // The Overview uses the shared segmented `RangePicker` — a single `radiogroup`
    // of preset radios ("Last 24h" / "Last 7d" / "Last 30d"), not a per-card
    // control and not a portaled Combobox. One group drives all three cards.
    await step('There is exactly one shared range picker, not one per card', async () => {
      await expect(canvas.getAllByRole('radiogroup', { name: /time range/i })).toHaveLength(1);
    });

    await step('24h is the default selection', async () => {
      await expect(canvas.getByRole('radio', { name: /last 24h/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    await step('Selecting 30d moves the selection', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /last 30d/i }));
      await expect(canvas.getByRole('radio', { name: /last 30d/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(canvas.getByRole('radio', { name: /last 24h/i })).toHaveAttribute(
        'aria-checked',
        'false',
      );
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
