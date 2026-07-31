import type { Meta, StoryObj } from '@storybook/react';
import { Info } from 'lucide-react';

import { Tooltip } from './Tooltip';

const meta: Meta<typeof Tooltip> = {
  title: 'UI/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered' },
  args: {
    content: 'Scopes are matched most-specific first.',
  },
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

const Trigger = () => (
  <span className="inline-flex size-6 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-content-tertiary)]">
    <Info className="size-3.5" aria-hidden />
  </span>
);

/**
 * Visual-regression story: the tooltip triggers across placements. The panels
 * are hidden at rest (state-driven visibility), so this snapshot fixes the
 * trigger affordance; the interaction test covers the shown state.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <Tooltip content="Top / center" side="top">
        <Trigger />
      </Tooltip>
      <Tooltip content="Bottom / left" side="bottom" align="left">
        <Trigger />
      </Tooltip>
      <Tooltip content="Bottom / right" side="bottom" align="right">
        <Trigger />
      </Tooltip>
    </div>
  ),
};

export const Playground: Story = {
  render: (args) => (
    <Tooltip {...args}>
      <Trigger />
    </Tooltip>
  ),
  args: {
    content: 'Scopes are matched most-specific first.',
    side: 'top',
    align: 'center',
  },
  argTypes: {
    content: { control: 'text' },
    side: { control: 'select', options: ['top', 'bottom'] },
    align: { control: 'select', options: ['left', 'center', 'right'] },
  },
};
