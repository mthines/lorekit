import type { Meta, StoryObj } from '@storybook/react';
import type { ReactElement } from 'react';
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

// ── Responsive layout ────────────────────────────────────────────────────────
//
// The rows switch between three columns and a stacked shape at the `@md`
// CONTAINER breakpoint, so both stories below narrow the container, never the
// viewport — narrowing the viewport would test a query the component does not
// make. `lorekit-web-daily-report` is the fixture name that used to clip
// mid-word at the old flat 176px column, so it is the one to measure.

const LONG_NAME_HANDLERS = [
  http.get('*/functions/v1/memories/read-activity', () =>
    HttpResponse.json({ bucket: 'day', since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW, buckets: FIXTURE_BUCKETS }),
  ),
  ...memoryHandlers(),
];

/** Widths in CSS px: a roomy card, and a phone's card (390px viewport less two `p-4`s). */
const WIDE_CARD = 640;
const PHONE_CARD = 326;

function widthDecorator(width: number) {
  return function WidthDecorator(Story: () => ReactElement) {
    return (
      <div data-testid="card" style={{ width }}>
        <Story />
      </div>
    );
  };
}

/** The row's bar track. It is decorative, so `data-slot` is the only handle. */
function barOf(row: Element): Element {
  const bar = row.querySelector('[data-slot="bar"]');
  if (!bar) throw new Error('row has no bar track');
  return bar;
}

/**
 * The row carrying a given scope name. Rows are ranked by count, so picking one
 * by position would silently follow the fixture's numbers around.
 */
function rowFor(canvasElement: HTMLElement, name: string): HTMLElement {
  const row = [...canvasElement.querySelectorAll('li')].find((li) => li.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

export const AWideCardKeepsThreeColumnsOnASharedBaseline: Story = {
  parameters: { msw: { handlers: LONG_NAME_HANDLERS } },
  decorators: [widthDecorator(WIDE_CARD)],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('lorekit-web-daily-report')).toBeVisible());

    await step('the longest scope name renders in full, not clipped mid-word', async () => {
      const name = canvas.getByText('lorekit-web-daily-report');
      // `truncate` clips with an ellipsis and leaves scrollWidth > clientWidth;
      // a name that fits reports them equal. Sub-pixel text metrics make this a
      // ±1px comparison, not an equality.
      await expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
    });

    await step('every bar starts at the same x, so the lengths stay comparable', async () => {
      const rows = canvasElement.querySelectorAll('li');
      const lefts = [...rows].map((row) => Math.round(barOf(row).getBoundingClientRect().left));
      // A name column that sized to its content would give each row a different
      // origin and the chart would stop being readable at a glance.
      await expect(new Set(lefts).size).toBe(1);
    });

    await step('the bar sits BETWEEN the name and the count on one line', async () => {
      const row = rowFor(canvasElement, 'lorekit-web-daily-report');
      const bar = barOf(row).getBoundingClientRect();
      const count = within(row).getByText((854).toLocaleString('en-US')).getBoundingClientRect();
      await expect(bar.top).toBeLessThan(count.bottom);
      await expect(bar.right).toBeLessThanOrEqual(count.left + 1);
    });
  },
};

export const APhoneWidthCardStacksTheBarOntoItsOwnLine: Story = {
  parameters: { msw: { handlers: LONG_NAME_HANDLERS } },
  decorators: [widthDecorator(PHONE_CARD)],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('lorekit-web-daily-report')).toBeVisible());
    const card = canvas.getByTestId('card').getBoundingClientRect();

    await step('the bar drops below the name rather than competing with it for width', async () => {
      const row = rowFor(canvasElement, 'lorekit-web-daily-report');
      const name = within(row).getByText('lorekit-web-daily-report').getBoundingClientRect();
      const bar = barOf(row).getBoundingClientRect();
      await expect(bar.top).toBeGreaterThanOrEqual(name.bottom);
    });

    await step('the count stays on the name’s line, at the right edge', async () => {
      const row = rowFor(canvasElement, 'lorekit-web-daily-report');
      const name = within(row).getByText('lorekit-web-daily-report').getBoundingClientRect();
      const count = within(row).getByText((854).toLocaleString('en-US')).getBoundingClientRect();
      // Same line as the name (they overlap vertically), and to its right.
      await expect(count.top).toBeLessThan(name.bottom);
      await expect(count.left).toBeGreaterThanOrEqual(name.right);
    });

    await step('nothing overflows the card horizontally', async () => {
      // The regression this whole layout exists for: a rigid three-column row
      // in a 326px card pushed the name column past the left edge.
      for (const row of canvasElement.querySelectorAll('li')) {
        const box = row.getBoundingClientRect();
        await expect(box.left).toBeGreaterThanOrEqual(card.left - 1);
        await expect(box.right).toBeLessThanOrEqual(card.right + 1);
      }
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
