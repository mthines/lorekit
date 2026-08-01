import type { Meta, StoryObj } from '@storybook/react';

import { LabelFilter } from './LabelFilter';
import type { TagCount } from '@/lib/tag-filter';

/**
 * Visual-regression stories for {@link LabelFilter} — the Lore Explorer's
 * searchable multi-select label filter.
 *
 * These fix the resting trigger states (inactive, and active with a clear
 * button); the open popover and its WAI-ARIA combobox keyboard model — the part
 * most likely to regress — are exercised by the interaction tests in
 * `LabelFilter.test.stories.tsx`, exactly as Tooltip splits its coverage.
 */
const meta: Meta<typeof LabelFilter> = {
  title: 'Lore/LabelFilter',
  component: LabelFilter,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof LabelFilter>;

const noop = () => undefined;

const CATALOG: TagCount[] = [
  { tag: 'performance', count: 24 },
  { tag: 'auth', count: 18 },
  { tag: 'database', count: 12 },
  { tag: 'ui', count: 9 },
  { tag: 'testing', count: 7 },
];

/**
 * The two resting trigger states side by side: inactive (no filter), and active
 * with a selection — which reveals the clear button beside the summary.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <LabelFilter catalog={CATALOG} selected={[]} onToggle={noop} onClear={noop} variant="desktop" />
      <LabelFilter
        catalog={CATALOG}
        selected={['auth', 'performance']}
        onToggle={noop}
        onClear={noop}
        variant="desktop"
      />
    </div>
  ),
};

export const Playground: Story = {
  render: (args) => <LabelFilter {...args} onToggle={noop} onClear={noop} />,
  args: {
    catalog: CATALOG,
    selected: ['auth'],
    variant: 'desktop',
  },
  argTypes: {
    variant: { control: 'select', options: ['desktop', 'mobile'] },
    selected: { control: 'object' },
  },
};
