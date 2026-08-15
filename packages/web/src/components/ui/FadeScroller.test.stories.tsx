import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor, within } from 'storybook/test';

import { FadeScroller } from './FadeScroller';

/**
 * Interaction tests for the edge-fade logic — the part a screenshot cannot
 * prove: that the fade tracks the scroll POSITION, appearing only on the side
 * with more content, and never on a row that fits.
 *
 * The assertions read the `data-fade-start` / `data-fade-end` contract rather
 * than a computed `mask-image`, which is the whole reason those attributes
 * exist.
 */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex min-h-7 shrink-0 items-center rounded-full border border-[var(--color-border)] px-3 text-xs">
      {children}
    </span>
  );
}

const meta: Meta<typeof FadeScroller> = {
  title: 'UI/FadeScroller/Tests',
  component: FadeScroller,
  tags: ['test'],
  parameters: { layout: 'padded', chromatic: { disableSnapshot: true } },
  decorators: [
    (Story) => (
      // A fixed, narrow width so the overflow is deterministic, not viewport-luck.
      <div style={{ width: '18rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof FadeScroller>;

export const FadesOnlyWhereThereIsMore: Story = {
  args: {
    role: 'group',
    'aria-label': 'scroller',
    className: 'items-center gap-2',
    children: Array.from({ length: 16 }, (_, i) => <Chip key={i}>chip-{i + 1}</Chip>),
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const scroller = await canvas.findByRole('group', { name: 'scroller' });

    await step('at the start: no start fade, end fades (more to the right)', async () => {
      await waitFor(async () => {
        await expect(scroller).toHaveAttribute('data-fade-start', 'false');
        await expect(scroller).toHaveAttribute('data-fade-end', 'true');
      });
    });

    await step('scrolled to the end: start fades, end does not', async () => {
      scroller.scrollLeft = scroller.scrollWidth;
      scroller.dispatchEvent(new Event('scroll'));
      await waitFor(async () => {
        await expect(scroller).toHaveAttribute('data-fade-start', 'true');
        await expect(scroller).toHaveAttribute('data-fade-end', 'false');
      });
    });

    await step('scrolled back to a middle position: both edges fade', async () => {
      scroller.scrollLeft = Math.round(scroller.scrollWidth / 2);
      scroller.dispatchEvent(new Event('scroll'));
      await waitFor(async () => {
        await expect(scroller).toHaveAttribute('data-fade-start', 'true');
        await expect(scroller).toHaveAttribute('data-fade-end', 'true');
      });
    });
  },
};

export const NoFadeWhenItFits: Story = {
  args: {
    role: 'group',
    'aria-label': 'fits',
    className: 'items-center gap-2',
    children: <Chip>only</Chip>,
  },
  play: async ({ canvasElement }) => {
    const scroller = await within(canvasElement).findByRole('group', { name: 'fits' });
    await waitFor(async () => {
      await expect(scroller).toHaveAttribute('data-fade-start', 'false');
      await expect(scroller).toHaveAttribute('data-fade-end', 'false');
    });
  },
};
