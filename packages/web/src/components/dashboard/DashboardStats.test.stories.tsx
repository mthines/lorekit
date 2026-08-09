import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { DashboardStats } from './DashboardStats';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link DashboardStats} — asserts the three cards
 * resolve against the MSW-mocked REST data and that the ONE shared range
 * selector is a working single-select driving all of them.
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

    // The picker is the shared `Combobox` now, so its popup is PORTALED to
    // document.body — the rows do not resolve inside the story canvas.
    const openPicker = async () => {
      const screen = within(document.body);
      // The popup unmounts through an `AnimatePresence` exit, so a reopen right
      // after a commit click would resolve against the OUTGOING listbox. Same
      // race the Combobox and StatusControl stories wait out.
      await waitFor(async () => {
        await expect(screen.queryByRole('listbox', { name: /time range/i })).toBeNull();
      });
      await userEvent.click(canvas.getByRole('button', { name: /^Time range:/ }));
      await screen.findByRole('listbox', { name: /time range/i });
      return screen;
    };

    await step('There is exactly one shared range picker, not one per card', async () => {
      await expect(canvas.getAllByRole('button', { name: /^Time range:/ })).toHaveLength(1);
    });

    await step('24h is the default, and the trigger says so before opening', async () => {
      await expect(canvas.getByRole('button', { name: /^Time range: 24h/ })).toBeInTheDocument();
    });

    await step('Selecting 30d moves the selection', async () => {
      const menu = await openPicker();
      await expect(menu.getByRole('option', { name: /24h/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await userEvent.click(menu.getByRole('option', { name: /30d/ }));
      await expect(canvas.getByRole('button', { name: /^Time range: 30d/ })).toBeInTheDocument();
    });

    await step('The shared range re-labels every card', async () => {
      const descriptions = await canvas.findAllByText(/in the last 30 days/i);
      await expect(descriptions.length).toBeGreaterThanOrEqual(2);
      await expect(
        canvas.getByText(/distinct scopes active in the last 30 days/i),
      ).toBeInTheDocument();
    });

    await step('Each row spells the preset out in words', async () => {
      // The reason the terse labels survived the move: the trigger stays as
      // narrow as the buttons it replaced, and the list carries the prose the
      // segmented group had nowhere to put.
      const menu = await openPicker();
      await expect(menu.getByText('Last 30 days')).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
    });
  },
};
