import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ContributionHeatmap } from './ContributionHeatmap';

/**
 * Interaction tests for {@link ContributionHeatmap}.
 *
 * The behaviour that needs a real browser is the RESPONSIVE sizing: the chart's
 * width used to be `weeks × 10px` regardless of its container, so it sat as a
 * fixed block in a wide panel and overflowed a narrow one. That is a computed
 * layout property — jsdom measures nothing, and a screenshot proves it at one
 * width only — so it is asserted here, at two container widths, against real
 * `getBoundingClientRect` values.
 *
 * The day-click gesture is covered too: it is what makes the heatmap a range
 * SELECTOR rather than a picture, and the `onSelectDate` contract is what
 * `LoreExplorer`'s anchor→extend behaviour is built on.
 */
const WEEKS = 13;

/** Dated relative to nothing — the grid is anchored on the real clock, so the
 *  cells these light up are irrelevant to every assertion below. What matters
 *  is that `max` is non-zero, so the legend and the intensity scale render. */
const DATA = [
  { date: '2026-06-08', count: 2 },
  { date: '2026-06-10', count: 5 },
  { date: '2026-06-12', count: 1 },
];

function Harness({ width, onSelectDate }: { width: number; onSelectDate: (d: string) => void }) {
  return (
    <div style={{ width, padding: 0 }} data-testid="heatmap-container">
      <ContributionHeatmap data={DATA} weeks={WEEKS} onSelectDate={onSelectDate} />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Activity/ContributionHeatmap/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'fullscreen' },
  args: { width: 900, onSelectDate: fn() },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/** Every day cell, in column-major order (the order the grid is filled in). */
const cells = (canvasElement: HTMLElement) =>
  Array.from(canvasElement.querySelectorAll('button[aria-label*="memor"]'));

/**
 * One day cell and its accessible name, by index.
 *
 * Throws rather than asserting non-null so a grid that rendered fewer cells than
 * the span asked for fails with a sentence saying so, instead of a `null` deref
 * three assertions later.
 */
function cellAt(canvasElement: HTMLElement, index: number): { el: HTMLElement; label: string } {
  const el = cells(canvasElement)[index];
  if (!el) throw new Error(`No day cell at index ${index} — the grid rendered too few cells`);
  const label = el.getAttribute('aria-label');
  if (!label) throw new Error(`The day cell at index ${index} has no accessible name`);
  return { el: el as HTMLElement, label };
}

export const FillsItsContainerAtAnyWidth: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const container = canvas.getByTestId('heatmap-container');

    await step('it draws one cell per day of the requested span', async () => {
      await expect(cells(canvasElement)).toHaveLength(WEEKS * 7);
    });

    await step('the grid reaches the container’s right edge', async () => {
      const all = cells(canvasElement);
      const last = all[all.length - 1]!;
      const box = container.getBoundingClientRect();
      // Within a couple of pixels of the edge — the old fixed-pitch grid stopped
      // ~600px short of a 900px container, so the tolerance is nowhere near
      // wide enough to let that regression back in.
      //
      // Read under `waitFor` because `getBoundingClientRect` is transform-
      // INCLUSIVE and the cells animate in from `scale(0.6)`. Caught mid-flight,
      // the last cell's right edge sits exactly `0.2 × trackWidth` short of the
      // container (a centre-origin 0.6 scale loses 0.4 × width, half off each
      // side) — that measures the ENTRY ANIMATION, not the layout this step is
      // about. The threshold is deliberately unchanged: a grid that genuinely
      // stops short of its container never converges, so the regression above
      // still fails here, it just no longer fails on a transient frame.
      await waitFor(() => expect(box.right - last.getBoundingClientRect().right).toBeLessThan(3));
    });

    await step('and it never overflows it', async () => {
      const box = container.getBoundingClientRect();
      for (const cell of cells(canvasElement)) {
        await expect(cell.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 1);
      }
    });

    await step('the cells are square, so the calendar still reads as a grid', async () => {
      const { width, height } = cellAt(canvasElement, 0).el.getBoundingClientRect();
      await expect(Math.abs(width - height)).toBeLessThan(1.5);
    });
  },
};

/**
 * The same component in a phone-width container.
 *
 * Two things are being pinned at once: that it still fills the width (no fixed
 * pitch), and that it does not overflow — the old version needed an
 * `overflow-x-auto` wrapper to survive a narrow viewport, which has been
 * removed.
 */
export const ShrinksToAPhoneWidthWithoutOverflowing: Story = {
  args: { width: 320 },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByTestId('heatmap-container').getBoundingClientRect();
    const all = cells(canvasElement);

    await step('the cells shrink rather than the grid scrolling', async () => {
      for (const cell of all) {
        await expect(cell.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 1);
      }
    });

    await step('and the last column still lands on the right edge', async () => {
      // Under `waitFor` for the same reason as the 900px story: the rect
      // includes the entry animation's `scale(0.6)` until it settles.
      const last = all[all.length - 1]!;
      await waitFor(() => expect(box.right - last.getBoundingClientRect().right).toBeLessThan(3));
    });
  },
};

/**
 * Cell size is the reason `weeks` is a per-breakpoint decision in
 * `ExplorerInsights`: at a fixed 9px the cells were below any reasonable touch
 * target, and the whole point of filling the width is that they no longer are.
 */
export const CellsGrowWithTheContainer: Story = {
  play: async ({ canvasElement, step }) => {
    await step('a 13-week span in a 900px panel gives a comfortably large cell', async () => {
      const { width } = cellAt(canvasElement, 0).el.getBoundingClientRect();
      // The old fixed cell was 9px. Anything at or below that means the fluid
      // grid silently stopped working.
      await expect(width).toBeGreaterThan(20);
    });
  },
};

/**
 * No month label may span past the last week column.
 *
 * A label that does makes CSS grid mint IMPLICIT columns, which take their
 * width out of the same fixed box — so every `1fr` cell column narrows and the
 * labels drift off the weeks they name, silently and without an error.
 *
 * **This is a partial repro, deliberately stated as one.** The grid is anchored
 * on the real clock (`new Date()` inside the component), and a label only lands
 * near the final column when today falls in the first two weeks of a month —
 * about half of all dates. The story's frozen-clock decorator cannot pin this
 * one, because `withFrozenClock` installs once per worker and an earlier story
 * may have claimed it. So the assertions below are written to be clock-INDEPENDENT
 * and correct on every date: they never false-fail, and on the dates that can
 * produce the bug they catch it.
 */
export const MonthLabelsNeverOverflowTheGrid: Story = {
  play: async ({ canvasElement, step }) => {
    const labelGrid = canvasElement.querySelectorAll('[style*="grid-template-columns"]')[0]!;

    await step('every label ends on or before the last column', async () => {
      const labels = Array.from(labelGrid.querySelectorAll('span')) as HTMLElement[];
      // Anti-vacuity: a selector that matched nothing would pass this loop
      // silently, which is the failure mode a DOM invariant test most often has.
      await expect(labels.length).toBeGreaterThan(0);

      for (const label of labels) {
        // `gridColumnStart` is "<n>" and `gridColumnEnd` is "span <n>" — read as
        // the two longhands rather than parsing the `gridColumn` shorthand,
        // whose serialisation ("1 / span 3") is easy to mis-split.
        const start = Number(label.style.gridColumnStart);
        const span = Number(label.style.gridColumnEnd.replace('span', '').trim());
        await expect(start - 1 + span).toBeLessThanOrEqual(WEEKS);
      }
    });

    await step('so the browser mints no implicit columns', async () => {
      // The consequence, measured rather than inferred: `grid-template-columns`
      // computes to the USED track list, so an overflowing label shows up here
      // as more tracks than were asked for.
      const tracks = getComputedStyle(labelGrid).gridTemplateColumns.split(/\s+/);
      await expect(tracks).toHaveLength(WEEKS);
    });

    await step('and the label grid shares the cell grid’s pitch', async () => {
      const cellGrid = canvasElement.querySelectorAll('[style*="grid-template-columns"]')[1]!;
      const pitch = (el: Element) =>
        getComputedStyle(el).gridTemplateColumns.split(/\s+/).map(parseFloat);
      const labels = pitch(labelGrid);
      const cells = pitch(cellGrid);
      await expect(labels).toHaveLength(cells.length);
      // Compared per track with a sub-pixel tolerance rather than by string
      // equality: the two grids are separate flex children, so their tracks can
      // round differently in the last fractional pixel while still being the
      // same pitch. A real misalignment — the implicit-column bug — moves a
      // track by whole pixels, not by a rounding step.
      for (let i = 0; i < cells.length; i++) {
        await expect(Math.abs(labels[i]! - cells[i]!)).toBeLessThan(1);
      }
    });
  },
};

export const ClickingADaySelectsIt: Story = {
  play: async ({ canvasElement, args, step }) => {
    await step('each cell is a button naming its date and count', async () => {
      const { el: first } = cellAt(canvasElement, 0);
      await expect(first).toHaveAttribute('aria-label', expect.stringMatching(/^\d{4}-\d{2}-\d{2}: \d+ memor/));
    });

    await step('clicking one reports its day', async () => {
      const { el: target, label } = cellAt(canvasElement, 10);
      const day = label.slice(0, 10);
      await userEvent.click(target);
      await expect(args.onSelectDate).toHaveBeenCalledWith(day);
    });
  },
};

/**
 * The day readout, which replaced the native `title` attribute.
 *
 * Two properties, and the second is the one that matters: it appears on FOCUS as
 * well as hover (a native `title` never did, so the counts were pointer-only),
 * and it is PORTALED to `<body>`. The portal is not decorative — this grid renders
 * inside the Activity panel's `overflow: hidden` reveal region, so an in-flow
 * panel would be clipped there exactly as the sparkbars' readout was.
 */
export const DayReadoutIsPortaledAndFollowsFocus: Story = {
  play: async ({ canvasElement, step }) => {
    const body = within(document.body);
    const { el: target, label } = cellAt(canvasElement, 10);
    const day = label.slice(0, 10);

    await step('the native title is gone — one tooltip per element, not two', async () => {
      await expect(target.hasAttribute('title')).toBe(false);
    });

    await step('nothing is shown until a day is hovered', async () => {
      await expect(body.queryByRole('tooltip')).toBeNull();
    });

    await step('hovering shows the count and the date', async () => {
      await userEvent.hover(target);
      await waitFor(async () => {
        const tooltip = body.getByRole('tooltip');
        await expect(tooltip.textContent).toContain(day);
        await expect(tooltip.textContent).toMatch(/\d+ memor/);
      });
    });

    await step('and it lives outside the grid, so nothing can clip it', async () => {
      const tooltip = body.getByRole('tooltip');
      await expect(tooltip.parentElement).toBe(document.body);
      await expect(canvasElement.contains(tooltip)).toBe(false);
      await expect(getComputedStyle(tooltip).position).toBe('fixed');
    });

    await step('unhovering closes it', async () => {
      await userEvent.unhover(target);
      await waitFor(async () => {
        await expect(body.queryByRole('tooltip')).toBeNull();
      });
    });

    await step('keyboard focus opens it too', async () => {
      target.focus();
      await expect(target).toHaveFocus();
      await waitFor(async () => {
        await expect(body.getByRole('tooltip').textContent).toContain(day);
      });
      // …and the cell points at it, so a screen reader announces the readout as
      // the description of the button it is on.
      await expect(target.getAttribute('aria-describedby')).toBeTruthy();
    });

    await step('Escape closes it without moving focus', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(async () => {
        await expect(body.queryByRole('tooltip')).toBeNull();
      });
      await expect(target).toHaveFocus();
    });
  },
};

/**
 * The readout and the accessible name must tell the same story about a square —
 * they are the sighted and the assistive readings of one fact, and they used to
 * be two independently written sentences ("3 memories on 2026-06-10" in `title`,
 * "2026-06-10: 3 memories" in `aria-label`), which is how they drift.
 */
export const ReadoutAndAccessibleNameAgree: Story = {
  play: async ({ canvasElement }) => {
    const body = within(document.body);
    const { el: target, label } = cellAt(canvasElement, 10);
    const [day, count] = label.split(': ');
    if (!count) throw new Error(`Unexpected accessible name shape: ${label}`);

    await userEvent.hover(target);
    await waitFor(async () => {
      const text = body.getByRole('tooltip').textContent ?? '';
      await expect(text).toContain(day);
      // `count` is "N memories"; the label may also carry " (selected)", which
      // the readout does not, so the containment is one-directional on purpose.
      await expect(text).toContain(count.replace(' (selected)', ''));
    });
  },
};
