import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ExplorerInstruments } from './ExplorerInstruments';
import { MatrixInstrument } from './MatrixInstrument';
import { TimelineInstrument } from './TimelineInstrument';
import { toggleFilterValue, type Filter, type FilterField } from '@/lib/filters';
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import { writePersistedPreference } from '@/lib/hooks/usePersistedPreference';
import type { Instrument } from '@/lib/explorer-instruments';
import type { PivotCell } from '@lorekit/schemas/memory';

/**
 * The Explorer's instrument panel — a collapsible strip of filter INPUTS above
 * the memory list.
 *
 * The stories deliberately show it EXPANDED, which is not its default: the
 * panel opens collapsed so it cannot push the list off a laptop screen, and a
 * baseline of a collapsed panel would only ever pin the header. The disclosure
 * itself is covered by the interaction tests next door.
 */

const CELLS: PivotCell[] = [
  { row: 'reviewer', col: 'signal', count: 92 },
  { row: 'reviewer', col: 'lesson', count: 41 },
  { row: 'aw', col: 'lesson', count: 28 },
  { row: 'implement-suggestion', col: 'lesson', count: 22 },
  { row: 'implement-suggestion', col: 'signal', count: 9 },
  { row: 'ci-auto-fix', col: 'lesson', count: 6 },
  { row: 'ci-auto-fix', col: 'bus', count: 2 },
  { row: 'fix-bug', col: 'lesson', count: 1 },
];

/** Real consecutive dates — a fixture that runs past month end is a baseline of a bug. */
const DAY_ONE = Date.UTC(2026, 6, 1);
const DAYS = Array.from({ length: 40 }, (_, i) => ({
  date: new Date(DAY_ONE + i * 86_400_000).toISOString().slice(0, 10),
  // A deterministic, bursty shape — the real series is spiky, and a smooth one
  // would make the baseline agree with a chart nobody has.
  count: [0, 0, 3, 11, 2, 0, 0, 41, 7, 1][i % 10] ?? 0,
}));

/**
 * Seed the panel's stored preferences BEFORE the first paint.
 *
 * The disclosure and the instrument choice live in `localStorage`, and the
 * component reads them through `useSyncExternalStore` — so writing them during
 * render (rather than clicking after it) is what makes the baseline capture a
 * settled state instead of racing an effect. The click paths themselves are
 * covered by the interaction tests next door; a screenshot only has to pin how
 * the settled state LOOKS.
 */
function seed(instrument: Instrument) {
  writePersistedPreference(PREFERENCE_KEYS.explorerInstrumentsOpen, '1');
  writePersistedPreference(PREFERENCE_KEYS.explorerInstrument, instrument);
}

function Panel({ open }: { open: Instrument }) {
  // Runs during the first render, before the store is read below it.
  seed(open);

  const [filters, setFilters] = useState<Filter[]>([]);
  const [range, setRange] = useState<{ from: string; to: string } | null>(
    open === 'timeline' ? { from: '2026-07-08', to: '2026-07-14' } : null,
  );
  const [row, setRow] = useState<FilterField>('host');
  const [col, setCol] = useState<FilterField>('kind');

  return (
    <div style={{ maxWidth: 760 }}>
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
    </div>
  );
}

const meta = {
  title: 'Lore/ExplorerInstruments',
  component: Panel,
  parameters: { layout: 'padded' },
  args: { open: 'matrix' },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The matrix. The populated corner sits top-left because both axes are ordered
 * densest-first, so the caps drop the sparse tail rather than an arbitrary
 * slice.
 */
export const Default: Story = {};

/** The timeline, with a window already brushed. */
export const Timeline: Story = {
  args: { open: 'timeline' },
};
