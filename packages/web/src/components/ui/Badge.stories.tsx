import type { Meta, StoryObj } from '@storybook/react';

import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'UI/Badge',
  component: Badge,
  parameters: { layout: 'centered' },
  args: { children: 'badge' },
};

export default meta;
type Story = StoryObj<typeof Badge>;

const VARIANTS = [
  'default',
  'global',
  'project',
  'repo',
  'branch',
  'agent',
  'blue',
  'green',
  'amber',
  'red',
  'purple',
] as const;

/**
 * Visual-regression story: every variant rendered together so one screenshot
 * covers the whole palette. A colour-token regression in any variant fails the
 * single snapshot.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', maxWidth: '22rem' }}>
      {VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
  ),
};

// Keeps the `StoryObj<typeof Badge>` type so a prop rename on `Badge` breaks
// this file at compile time — never redeclare a parallel args type.
export const Playground: Story = {
  args: {
    children: 'repo::mthines/lorekit',
    variant: 'repo',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: VARIANTS,
      description: 'Colour variant (scope-bound or generic semantic).',
    },
    children: { control: 'text', description: 'Badge label.' },
    className: { control: 'text' },
  },
};
