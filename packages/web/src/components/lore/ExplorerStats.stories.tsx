import type { Meta, StoryObj } from '@storybook/react';

import { ExplorerStats } from './ExplorerStats';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the Explorer's stats header.
 *
 * The component fetches over TanStack Query → the REST edge functions, which
 * MSW mocks, so these render the REAL component against a realistic dataset
 * rather than a prop-fed shell.
 *
 * Determinism: the trend chips and sparkbars are period-over-period, so the
 * clock is frozen to {@link FROZEN_NOW} (fixtures are dated relative to it) and
 * the query client retries off / never refetches — one settled render, one
 * baseline.
 *
 * The scenarios below are DATA and SELECTION states rather than a prop
 * `Playground`, because that is what actually varies in use: all scopes vs one,
 * and with vs without a filter bar narrowing the list underneath.
 */
const meta: Meta<typeof ExplorerStats> = {
  title: 'Lore/ExplorerStats',
  component: ExplorerStats,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof ExplorerStats>;

/** All scopes, no filters — the Explorer's resting state. */
export const Default: Story = {
  args: {
    scope: null,
    range: { preset: '30d' },
    filters: [],
    scopeLabel: 'All scopes',
  },
  render: (args) => (
    <div style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <ExplorerStats {...args} />
    </div>
  ),
};

/**
 * One scope selected.
 *
 * Written / Read / Scopes narrow; **Expired does not** — its caption drops the
 * scope name and reads "across your account", because the underlying expiry
 * event carries no scope to filter on. That asymmetry is the thing worth
 * eyeballing here.
 */
export const ScopeSelected: Story = {
  args: {
    scope: 'repo::mthines/lorekit',
    range: { preset: '30d' },
    filters: [],
    scopeLabel: 'mthines/lorekit',
  },
  render: Default.render,
};

/**
 * A filter bar is active.
 *
 * The header gains one line of copy stating that the filters narrow the list
 * below and not these numbers — the only moment the discrepancy can mislead,
 * and therefore the only moment it is spelled out.
 */
export const WithActiveFilters: Story = {
  args: {
    scope: 'repo::mthines/lorekit',
    range: { preset: '7d' },
    filters: [{ field: 'kind', operator: 'in', values: ['lesson'] }],
    scopeLabel: 'mthines/lorekit',
  },
  render: Default.render,
};

/**
 * An absolute range drilled in from a chart.
 *
 * Captions read as dates rather than as a duration, and the grid anchors at the
 * window's own end (`gridAnchor`) — so the bars describe the selected days and
 * not the most recent ones.
 */
export const AbsoluteRange: Story = {
  args: {
    scope: null,
    range: { from: '2026-06-10', to: '2026-06-12' },
    filters: [],
    scopeLabel: 'All scopes',
  },
  render: Default.render,
};
