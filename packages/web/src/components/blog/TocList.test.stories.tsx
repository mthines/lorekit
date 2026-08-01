import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { TocList } from './TocList';
import type { TocItem } from '@/lib/blog/toc';

/**
 * Interaction tests for {@link TocList} — the shared, presentational TOC list.
 * Cover its contract: the active item carries `aria-current="location"`, and a
 * click reports the target id via `onNavigate` (which, returning `true`, means
 * the component takes over navigation instead of the native anchor jump).
 *
 * The full scroll-spy wiring lives in {@link useActiveHeading}; this file stays
 * on the deterministic list contract so it can't flake on layout/scroll.
 */

const ITEMS: readonly TocItem[] = [
  { id: 'amnesia', text: 'Your agent has amnesia', depth: 2 },
  { id: 'trigger', text: 'The failure is the trigger', depth: 2 },
  { id: 'gradient', text: 'Memory has a gradient', depth: 2 },
];

const meta: Meta<typeof TocList> = {
  title: 'Blog/TocList/Tests',
  component: TocList,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
  args: { items: ITEMS, activeId: 'trigger', onNavigate: fn(() => true), layoutId: 'sb-toc-test' },
};

export default meta;
type Story = StoryObj<typeof TocList>;

export const MarksActiveAndReportsNavigation: Story = {
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);

    await step('the active item is marked for assistive tech', async () => {
      const active = canvas.getByRole('link', { name: 'The failure is the trigger' });
      await expect(active).toHaveAttribute('aria-current', 'location');
    });

    await step('other items are not marked active', async () => {
      const other = canvas.getByRole('link', { name: 'Memory has a gradient' });
      await expect(other).not.toHaveAttribute('aria-current');
    });

    await step('clicking an item reports its id to onNavigate', async () => {
      await userEvent.click(canvas.getByRole('link', { name: 'Memory has a gradient' }));
      await expect(args.onNavigate).toHaveBeenCalledWith('gradient');
    });
  },
};
