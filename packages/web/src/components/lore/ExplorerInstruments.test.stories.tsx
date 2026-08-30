import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ExplorerInstruments } from './ExplorerInstruments';
import { MatrixInstrument } from './MatrixInstrument';
import { TimelineInstrument } from './TimelineInstrument';
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import { toggleFilterValue, type Filter, type FilterField } from '@/lib/filters';
import type { Instrument } from '@/lib/explorer-instruments';
import type { PivotCell } from '@lorekit/schemas/memory';

/**
 * Interaction tests for the Explorer's instrument panel.
 *
 * The screenshot stories cover how it looks. These cover the three things that
 * decide whether it is usable and that a picture cannot show:
 *
 *  - it opens COLLAPSED and the choice survives a remount (small screens),
 *  - a matrix cell writes the two filter pills it stands for, through the same
 *    `toggleFilterValue` the menu uses,
 *  - the timeline's brush is a POINTER gesture, so it works with a touch
 *    pointer and not only a mouse.
 */

const CELLS: PivotCell[] = [
  { row: 'reviewer', col: 'signal', count: 9 },
  { row: 'reviewer', col: 'lesson', count: 4 },
  { row: 'aw', col: 'lesson', count: 3 },
  { row: 'ci-auto-fix', col: 'lesson', count: 1 },
];

const DAYS = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-08-${String(i + 1).padStart(2, '0')}`,
  count: (i * 7) % 11,
}));

/** Clears the stored preferences so each story starts from the product default. */
function resetPreferences() {
  try {
    window.localStorage.removeItem(PREFERENCE_KEYS.explorerInstrumentsOpen);
    window.localStorage.removeItem(PREFERENCE_KEYS.explorerInstrument);
  } catch {
    // Blocked site data behaves like "nothing stored", which is the same start.
  }
}

/** A harness holding the filter bar, so a cell click can be observed as pills. */
function Harness({ instrument = 'matrix' as Instrument }: { instrument?: Instrument }) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [row, setRow] = useState<FilterField>('host');
  const [col, setCol] = useState<FilterField>('kind');

  return (
    <div style={{ maxWidth: 860 }}>
      <ExplorerInstruments
        activeFilterCount={filters.length}
        renderInstrument={(active) =>
          active === 'matrix' ? (
            <MatrixInstrument
              row={row}
              col={col}
              onRowChange={setRow}
              onColChange={setCol}
              cells={CELLS}
              serverTruncated={false}
              isLoading={false}
              isError={false}
              filters={filters}
              onSelectCell={(r, c) =>
                setFilters((prev) =>
                  toggleFilterValue(toggleFilterValue(prev, r.field, r.value), c.field, c.value),
                )
              }
            />
          ) : (
            <TimelineInstrument
              days={DAYS}
              selected={range}
              onSelectRange={setRange}
              onClear={() => setRange(null)}
            />
          )
        }
      />
      {/* Observation surfaces — the assertions read these rather than reaching
          into component internals. */}
      <p data-testid="filters">
        {filters.map((f) => `${f.field}:${f.values.join('|')}`).join(' ') || 'none'}
      </p>
      <p data-testid="range">{range ? `${range.from}..${range.to}` : 'none'}</p>
      <p data-testid="preferred-instrument">{instrument}</p>
    </div>
  );
}

const meta = {
  title: 'Lore/Tests/ExplorerInstruments',
  component: Harness,
  parameters: { layout: 'padded', chromatic: { disableSnapshot: true } },
  tags: ['test'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel opens collapsed — the whole reason it is a disclosure. A second
 * always-open panel would push the memory list off a laptop screen, which is
 * exactly what the Activity panel's own disclosure exists to prevent.
 */
export const OpensCollapsed: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole('button', { name: /show filter instruments/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed means the body is genuinely absent, not merely invisible: it
    // must be out of the tab order and out of find-in-page.
    await expect(canvas.queryByRole('table')).not.toBeInTheDocument();
  },
};

/**
 * Expanding, and the choice persisting. The persistence is what makes a
 * collapsed default acceptable on a small screen: a reader who wants the panel
 * opens it once, not on every visit.
 */
export const ExpandsAndRemembers: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole('button', { name: /show filter instruments/i }));
    await waitFor(async () => {
      await expect(await canvas.findByRole('table')).toBeInTheDocument();
    });

    // The store is what a remount reads, so assert on the store rather than on
    // a re-render this test cannot force.
    await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInstrumentsOpen)).toBe('1');

    await userEvent.click(await canvas.findByRole('button', { name: /hide filter instruments/i }));
    await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInstrumentsOpen)).toBe('0');
  },
};

/**
 * Picking an instrument while folded EXPANDS. Without this the segment lights up
 * and nothing else happens, which reads as a dead control — and "show me the
 * timeline" is a request to see it, not to select it.
 */
export const PickingAnInstrumentWhileFoldedExpands: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole('radio', { name: /timeline/i }));
    await waitFor(async () => {
      await expect(
        await canvas.findByRole('button', { name: /hide filter instruments/i }),
      ).toBeInTheDocument();
    });
    await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInstrument)).toBe('timeline');
  },
};

/**
 * THE instrument contract: a cell is two filters. It goes through the same
 * `toggleFilterValue` the menu and the pills use, so a cell click is
 * indistinguishable from having typed both values.
 */
export const MatrixCellWritesTwoFilters: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /show filter instruments/i }));

    const cell = await canvas.findByRole('button', {
      name: /Host reviewer, Kind signal: 9 memories/i,
    });
    await userEvent.click(cell);

    await waitFor(async () => {
      await expect(canvas.getByTestId('filters')).toHaveTextContent('host:reviewer');
      await expect(canvas.getByTestId('filters')).toHaveTextContent('kind:signal');
    });
    // Selection is DERIVED from the bar, never held by the grid, so the two can
    // never disagree.
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
  },
};

/** An empty pair is not a filter worth offering — selecting it would empty the list. */
export const EmptyCellsAreNotSelectable: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /show filter instruments/i }));

    const empty = await canvas.findByRole('button', {
      name: /Host aw, Kind signal: 0 memories/i,
    });
    await expect(empty).toBeDisabled();
  },
};

/**
 * The brush is a POINTER gesture, driven here with a `touch` pointer — the
 * breakpoint this feature had to work at. `setPointerCapture` and the
 * `touch-action: none` track are what make the same code path serve a thumb and
 * a mouse.
 */
export const TimelineBrushWorksWithATouchPointer: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole('radio', { name: /timeline/i }));
    const first = await canvas.findByRole('button', { name: /2026-08-02/ });
    const last = await canvas.findByRole('button', { name: /2026-08-09/ });

    // Driven through user-event's pointer API with a TOUCH pointer, so the test
    // exercises the same event sequence a thumb produces rather than a
    // hand-rolled approximation of one.
    //
    // Coordinates are given EXPLICITLY. The component reads `clientX` against
    // the track's own box to decide which day was hit, and user-event's default
    // position for a target is not the element centre — leaving it implicit
    // made the drag's anchor land on the wrong bar, which is precisely the bug
    // this test exists to catch.
    const centre = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };

    await userEvent.pointer([
      { keys: '[TouchA>]', target: first, coords: centre(first) },
      { pointerName: 'TouchA', target: last, coords: centre(last) },
      { keys: '[/TouchA]', target: last, coords: centre(last) },
    ]);

    await waitFor(async () => {
      await expect(canvas.getByTestId('range')).toHaveTextContent('2026-08-02..2026-08-09');
    });
  },
};

/** A tap is a one-day window, not a dropped gesture. */
export const TimelineTapSelectsOneDay: Story = {
  play: async ({ canvasElement }) => {
    resetPreferences();
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole('radio', { name: /timeline/i }));
    const bar = await canvas.findByRole('button', { name: /2026-08-05/ });

    // A tap is a pointer gesture, so it goes through the TRACK (a drag whose
    // anchor and head agree) — which means it needs real coordinates, exactly
    // as the brush does. `userEvent.click` synthesises none.
    const box = bar.getBoundingClientRect();
    const coords = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    await userEvent.pointer([
      { keys: '[TouchA>]', target: bar, coords },
      { keys: '[/TouchA]', target: bar, coords },
    ]);

    await waitFor(async () => {
      await expect(canvas.getByTestId('range')).toHaveTextContent('2026-08-05..2026-08-05');
    });
  },
};
