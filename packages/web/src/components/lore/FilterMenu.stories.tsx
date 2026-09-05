import type { Meta, StoryObj } from '@storybook/react';

import { FilterMenu } from './FilterMenu';
import { FilterPillRow } from './FilterBar';
import { APPLIED_FILTERS, FACETS } from './filter-fixtures';
import type { RetentionConditions } from '@/lib/retention-filter';

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
 * Two thresholds from opposite ends of the set: a date, whose value reads as a
 * duration, and `Chosen: 0`, whose value reads as a WORD ("Never chosen"). If
 * the pill ever renders a bare `0` there, this baseline is where it shows.
 */
const RETENTION: RetentionConditions = { minAgeDays: 30, maxOpenedCount: 0 };


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

/**
 * The bar with both halves filled: dimension pills, threshold pills, and the
 * "Create retention policy" hand-off that a filtered view earns.
 *
 * The two pill shapes have to read as one family and stay tellable apart — a
 * `RetentionPill` has three segments where a `FilterPill` has four, because a
 * threshold's comparison is baked into its wording ("Never chosen") and an
 * inert `is` segment would spend a third of the pill saying nothing. This is
 * the baseline that catches the two drifting apart.
 */
export const WithRetentionConditions: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: 620 }}>
      <FilterMenu
        facets={FACETS}
        filters={APPLIED_FILTERS}
        onToggleValue={noop}
        retention={RETENTION}
        onRetentionChange={noop}
        variant="desktop"
      />
      <FilterPillRow
        filters={APPLIED_FILTERS}
        onOperatorChange={noop}
        onRemove={noop}
        onClearAll={noop}
        onEditField={noop}
        retention={RETENTION}
        onRetentionChange={noop}
        onEditRetentionField={noop}
        onCreatePolicy={noop}
      />
    </div>
  ),
};

/**
 * The menu OPEN at level one, which is where the merge actually shows.
 *
 * Nine dimensions, then an "Age & activity" heading, then the five thresholds —
 * one list, one scroll, one answer to "what can I filter by?". Two of them carry
 * their applied value as a badge, so the row list doubles as the summary and a
 * reader does not have to drill in to see what is set.
 *
 * A `play` opens it rather than a prop forcing it, so the baseline captures the
 * real popover (portaled, measured, animated into place) and not an
 * approximation of one.
 */
export const MenuOpenWithRetentionRows: Story = {
  render: () => (
    <div style={{ width: 620, height: 560 }}>
      <FilterMenu
        facets={FACETS}
        filters={APPLIED_FILTERS}
        onToggleValue={noop}
        retention={RETENTION}
        onRetentionChange={noop}
        variant="desktop"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: /add or edit a filter/i }),
    );
    // Let the popover's fade + scale settle so the screenshot is not mid-transition.
    await new Promise((r) => setTimeout(r, 400));
  },
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
