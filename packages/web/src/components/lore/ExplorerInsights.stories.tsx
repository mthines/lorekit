import type { Meta, StoryObj } from '@storybook/react';

import { ExplorerInsights } from './ExplorerInsights';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { NO_RETENTION_CONDITIONS } from '@/lib/retention-filter';

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
 * The panel's disclosure state and chosen view are PERSISTED, and the browser
 * suite shares one origin, so a story that switched views could otherwise decide
 * what a LATER file's baseline depicts. Both keys are reset before every story
 * globally, in `.storybook/vitest.setup.ts` — see the note there.
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
    // Required by the component (00108), and required HERE rather than left to
    // TypeScript: Storybook lets `meta.args` and a story's `args` each supply
    // part of the prop set, so a missing required prop is not a type error in a
    // story file — it is an `undefined` read at render time. The empty set is
    // the right default: these baselines depict the Explorer with no threshold
    // chosen. A story that wants one overrides it.
    retention: NO_RETENTION_CONDITIONS,
  },
};

export default meta;
type Story = StoryObj<typeof ExplorerInsights>;

/**
 * All scopes, no filters — the Explorer's resting state, which is now EXPANDED on
 * the `charts` view: the five cards with their trends and sparkbars, the view
 * toggle where the `Activity · <scope>` label used to be, and no heatmap stacked
 * underneath.
 */
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
 * PHONE width — the layout the header has to survive.
 *
 * Three controls now share the header row — the view toggle, the range picker and
 * the chevron — and the row must not wrap. The toggle is what gives: it drops its
 * labels to icons below the panel's `@md` container width, so the row stays one
 * line at a width where three labelled controls could not. That is the layout most
 * likely to regress silently, and a desktop screenshot cannot show it.
 *
 * Below the header the cards go ONE-up (this container is under the `@sm`
 * breakpoint), which is deliberate: two cards in a ~350px column would crush the
 * number that is the whole point of a card.
 *
 * The container is narrowed rather than the viewport, which is exactly right for
 * the toggle and the card grid — both are container queries — and is why the
 * heatmap's span is not pinned here: that one comes from a real media query
 * (`useIsMobile`).
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
 * The COLLAPSED state, reached the way a reader reaches it.
 *
 * The inverse of `Default` now that the panel opens expanded. It is the state the
 * disclosure is judged on: the four numbers stay — the ANSWER — while every piece
 * of evidence folds away, so collapsing buys space without costing the figure you
 * came for.
 */
export const Collapsed: Story = {
  args: Default.args,
  render: Default.render,
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
    // Let the height animation settle so the screenshot is not mid-transition.
    await new Promise((r) => setTimeout(r, 400));
  },
};

/**
 * The HEATMAP view, reached the way a reader reaches it.
 *
 * The other half of the view toggle, and the state that replaced the old stacked
 * layout: the calendar gets the panel entirely to itself. The five cards are not
 * merely folded here — they are absent, because keeping them above the calendar
 * rebuilt the two-charts-in-one-card stack this panel exists to remove. A play
 * function switches the view before the screenshot so the baseline captures the
 * real thing rather than a prop-forced approximation.
 */
export const HeatmapView: Story = {
  args: Default.args,
  render: Default.render,
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    const canvas = within(canvasElement);
    const toggle = within(canvas.getByRole('radiogroup', { name: /activity view/i }));
    await userEvent.click(toggle.getByRole('radio', { name: /heatmap/i }));
    // The height animation plus the heatmap's own staggered cell entrance.
    await new Promise((r) => setTimeout(r, 600));
  },
};
