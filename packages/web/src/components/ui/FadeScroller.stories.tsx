import type { Meta, StoryObj } from '@storybook/react';

import { FadeScroller } from './FadeScroller';

/**
 * Visual-regression stories for the edge-fading horizontal scroller.
 * `Overflowing` shows the end-edge fade; `Fits` proves a row that fits gets no
 * fade at all (the anti-vignette case).
 */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex min-h-7 shrink-0 items-center rounded-full border border-[var(--color-border)] px-3 text-xs text-[var(--color-content-secondary)]">
      {children}
    </span>
  );
}

const meta: Meta<typeof FadeScroller> = {
  title: 'UI/FadeScroller',
  component: FadeScroller,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '22rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof FadeScroller>;

/** More chips than fit → the end edge fades to signal there is more to scroll. */
export const Overflowing: Story = {
  args: {
    className: 'items-center gap-2',
    children: Array.from({ length: 14 }, (_, i) => <Chip key={i}>chip-{i + 1}</Chip>),
  },
};

/** A row that fits its width gets no fade on either edge. */
export const Fits: Story = {
  args: {
    className: 'items-center gap-2',
    children: [<Chip key="a">one</Chip>, <Chip key="b">two</Chip>],
  },
};
