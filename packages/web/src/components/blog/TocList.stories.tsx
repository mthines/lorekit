import type { Meta, StoryObj } from '@storybook/react';

import { TocList } from './TocList';
import type { TocItem } from '@/lib/blog/toc';

const ITEMS: readonly TocItem[] = [
  { id: 'amnesia', text: 'Your agent has amnesia', depth: 2 },
  { id: 'loop', text: "Self-healing isn't magic — it's read → fail → write", depth: 2 },
  { id: 'trigger', text: 'The failure is the trigger', depth: 2 },
  { id: 'conservative', text: 'Conservative on purpose', depth: 3 },
  { id: 'gradient', text: 'Memory has a gradient', depth: 2 },
  { id: 'guardrails', text: 'The dangerous part: not entrenching mistakes', depth: 2 },
];

const meta: Meta<typeof TocList> = {
  title: 'Blog/TocList',
  component: TocList,
  parameters: { layout: 'padded' },
  args: { items: ITEMS, activeId: 'trigger', onNavigate: () => true, layoutId: 'sb-toc' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '15rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TocList>;

/** Visual-regression story: the shared TOC list with the third item active —
 *  covers the sliding pill, the rail spine, and h3 indentation in one snapshot. */
export const Default: Story = {};

export const Playground: Story = {
  args: { activeId: 'amnesia' },
  argTypes: {
    activeId: {
      control: 'select',
      options: ITEMS.map((i) => i.id),
      description: 'Which heading is the active section.',
    },
    layoutId: { control: false },
    onNavigate: { control: false },
  },
};
