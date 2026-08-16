import type { Meta, StoryObj } from '@storybook/react';

import { ExplorerInsights } from './ExplorerInsights';
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
/** A short dated series so the heatmap has something to draw when expanded. */
const HEATMAP = [
  { date: '2026-06-08', count: 2 },
  { date: '2026-06-10', count: 5 },
  { date: '2026-06-12', count: 1 },
];

const meta: Meta<typeof ExplorerInsights> = {
  title: 'Lore/ExplorerInsights',
  component: ExplorerInsights,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  // Shared across every story: the panel needs a heatmap dataset and a clock,
  // and repeating them per story is how two stories end up describing
  // different instants.
  args: {
    onRangeChange: () => undefined,
    filters: [],
    heatmapData: HEATMAP,
    highlightRange: null,
    onSelectDate: () => undefined,
    nowIso: FROZEN_NOW,
  },
};

export default meta;
type Story = StoryObj<typeof ExplorerInsights>;

/** All scopes, no filters — the Explorer's resting state. */
export const Default: Story = {
  args: {
    scope: null,
    range: { preset: '30d' },
    scopeLabel: 'All scopes',
  },
  render: (args) => (
    <div style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <ExplorerInsights {...args} />
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
    scopeLabel: 'mthines/lorekit',
  },
  render: Default.render,
};

/**
 * A filter bar is active.
 *
 * The Written and Scopes cards now NARROW to the filtered set (migration 00063)
 * — the header agrees with the list, so there is no disclaimer. Read stays
 * scope-level (usage_events has no per-memory dimension) and Expired stays
 * account-wide.
 */
export const WithActiveFilters: Story = {
  args: {
    scope: 'repo::mthines/lorekit',
    filters: [{ field: 'label', operator: 'in', values: ['perf-regression'] }],
    range: { preset: '7d' },
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
    scopeLabel: 'All scopes',
  },
  render: Default.render,
};

/**
 * The collapsed strip at PHONE width.
 *
 * The four numbers stay on ONE row of four equal columns here, which is the
 * whole point of the grid: the wrapping flex row this replaced broke into two
 * ragged lines below ~500px, so the summary that is meant to be readable at a
 * glance took two. Worth its own baseline because it is the layout most likely
 * to regress silently — a desktop screenshot cannot show it.
 *
 * The container is narrowed rather than the viewport, so this pins the strip
 * only. The heatmap's span is chosen from a real media query (`useIsMobile`),
 * which a narrow container does not move — and the strip is what collapses.
 */
export const Narrow: Story = {
  args: {
    scope: null,
    range: { preset: '30d' },
    scopeLabel: 'All scopes',
  },
  render: (args) => (
    <div style={{ maxWidth: '23rem', padding: '0.75rem' }}>
      <ExplorerInsights {...args} />
    </div>
  ),
};

/**
 * The EXPANDED state, reached the way a reader reaches it.
 *
 * Worth its own baseline because it is the state the redesign is judged on: the
 * four cards and the heatmap in one panel, under one header, with the range
 * picker still in reach. A play function opens it before the screenshot so the
 * baseline captures the real thing rather than a prop-forced approximation.
 */
export const Expanded: Story = {
  args: Default.args,
  render: Default.render,
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /show activity detail/i }));
    // Let the height animation settle so the screenshot is not mid-transition.
    await new Promise((r) => setTimeout(r, 400));
  },
};
