import type { Meta, StoryObj } from '@storybook/react';

import { FilterMenu } from './FilterMenu';
import { FilterPillRow } from './FilterBar';
import { APPLIED_FILTERS, FACETS } from './filter-fixtures';

/**
 * Visual-regression stories for the Lore Explorer's filter surface — the
 * {@link FilterMenu} trigger and the committed {@link FilterPillRow} beneath it.
 *
 * These fix the resting states. The two-level menu itself — the dimension list,
 * the drill-in, the cross-dimension type-ahead and the whole keyboard model —
 * is the part most likely to regress and is exercised by the interaction tests
 * in `FilterMenu.test.stories.tsx`, exactly as Tooltip and the old LabelFilter
 * split their coverage.
 */
const meta: Meta<typeof FilterMenu> = {
  title: 'Lore/FilterMenu',
  component: FilterMenu,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof FilterMenu>;

const noop = () => undefined;


/**
 * The resting trigger, and the pill row that a filled bar produces — the two
 * halves of the surface, stacked as they appear in the Explorer.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: 620 }}>
      <div style={{ display: 'flex', gap: '2rem' }}>
        <FilterMenu facets={FACETS} filters={[]} onToggleValue={noop} variant="desktop" />
        <FilterMenu facets={FACETS} filters={APPLIED_FILTERS} onToggleValue={noop} variant="mobile" />
      </div>
      <FilterPillRow
        filters={APPLIED_FILTERS}
        onOperatorChange={noop}
        onRemove={noop}
        onClearAll={noop}
        onEditField={noop}
      />
    </div>
  ),
};

export const Playground: Story = {
  render: (args) => <FilterMenu {...args} onToggleValue={noop} />,
  args: {
    facets: FACETS,
    filters: APPLIED_FILTERS,
    variant: 'desktop',
  },
  argTypes: {
    variant: { control: 'select', options: ['desktop', 'mobile'] },
    filters: { control: 'object' },
  },
};
