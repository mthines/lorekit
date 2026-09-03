import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, within, waitFor, userEvent } from 'storybook/test';

import { ScopeConsumption } from './ScopeConsumption';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link ScopeConsumption} — asserts the additive
 * invariant (bars sum to the headline, including the unattributed bucket) and
 * that the unattributed bucket is labelled rather than dropped.
 */
const meta: Meta<typeof ScopeConsumption> = {
  title: 'Lore/ScopeConsumption/Tests',
  component: ScopeConsumption,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  args: {
    since: '2026-07-01T00:00:00.000Z',
    until: FROZEN_NOW,
  },
};

export default meta;
type Story = StoryObj<typeof ScopeConsumption>;

const FIXTURE_BUCKETS = [
  { bucket: '2026-07-05T00:00:00.000Z', scope: 'repo::mthines/lorekit', count: 58631 },
  { bucket: '2026-07-05T00:00:00.000Z', scope: 'global', count: 110187 },
  { bucket: '2026-07-05T00:00:00.000Z', scope: 'project::lorekit-web-daily-report', count: 854 },
  { bucket: '2026-07-05T00:00:00.000Z', scope: null, count: 145260 },
];
const FIXTURE_TOTAL = FIXTURE_BUCKETS.reduce((sum, b) => sum + b.count, 0);

export const HeadlineSumsToTotalIncludingUnattributed: Story = {
  parameters: {
    msw: {
      // MSW resolves handlers in list order (first match wins), so the
      // override must come BEFORE `...memoryHandlers()` or its own
      // read-activity fixture always wins instead.
      handlers: [
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({ bucket: 'day', since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW, buckets: FIXTURE_BUCKETS }),
        ),
        ...memoryHandlers(),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the headline total equals the sum of every row, including the unattributed bucket', async () => {
      await waitFor(() => expect(canvas.getByText(/records read/i)).toBeVisible());
      // AnimatedNumber renders the figure TWICE (an aria-hidden animated node
      // plus a `.sr-only` node with the exact, unabbreviated value) — the house
      // rule is to read the `.sr-only` half, never the (ambiguous) `textContent`.
      await expect(
        canvas.getByText(FIXTURE_TOTAL.toLocaleString('en-US'), { selector: '.sr-only' }),
      ).toBeInTheDocument();
    });
    await step('the unattributed bucket renders as its own labelled row, not dropped', async () => {
      await expect(canvas.getByText('unattributed')).toBeVisible();
      await expect(canvas.getByText((145260).toLocaleString('en-US'))).toBeVisible();
    });
    await step('a NAMED scope links into the Explorer narrowed to it', async () => {
      await expect(canvas.getByRole('link', { name: /mthines\/lorekit/ })).toHaveAttribute(
        'href',
        '/lore?scope=repo%3A%3Amthines%2Florekit',
      );
    });
    await step('the unattributed row stays INERT — there is no scope to narrow to', async () => {
      // Linking it would silently show a different set of lore than the bar
      // measures.
      await expect(canvas.queryByRole('link', { name: /unattributed/ })).not.toBeInTheDocument();
    });
  },
};

/** More named scopes than the default limit (8) — the "+N more" truncation used to be a dead end. */
const MANY_SCOPES_BUCKETS = Array.from({ length: 12 }, (_, i) => ({
  bucket: '2026-07-05T00:00:00.000Z',
  scope: `repo::mthines/scope-${i}`,
  count: (12 - i) * 10,
}));

export const TruncatedScopesExpandOnClick: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({
            bucket: 'day',
            since: '2026-07-01T00:00:00.000Z',
            until: FROZEN_NOW,
            buckets: MANY_SCOPES_BUCKETS,
          }),
        ),
        ...memoryHandlers(),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('only the first 8 scopes render, with a toggle for the rest', async () => {
      await waitFor(() => expect(canvas.getByText('mthines/scope-0')).toBeVisible());
      await expect(canvas.queryByText('mthines/scope-9')).not.toBeInTheDocument();
      await expect(canvas.getByRole('button', { name: 'Show 4 more scopes' })).toBeVisible();
    });
    await step('clicking the toggle reveals the rest and flips its own label', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Show 4 more scopes' }));
      await expect(canvas.getByText('mthines/scope-9')).toBeVisible();
      await expect(canvas.getByText('mthines/scope-11')).toBeVisible();
      await expect(canvas.getByRole('button', { name: 'Show fewer scopes' })).toBeVisible();
    });
    await step('clicking again collapses back to the first 8', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Show fewer scopes' }));
      await expect(canvas.queryByText('mthines/scope-9')).not.toBeInTheDocument();
      await expect(canvas.getByRole('button', { name: 'Show 4 more scopes' })).toBeVisible();
    });
  },
};

export const EmptyWindowShowsNoReadsMessage: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({ bucket: 'day', since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW, buckets: [] }),
        ),
        ...memoryHandlers(),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('an empty window renders the empty-state message, not a zero-filled leaderboard', async () => {
      await waitFor(() => expect(canvas.getByText(/no memory reads recorded/i)).toBeVisible());
    });
  },
};
