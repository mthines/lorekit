'use client';

/**
 * MatrixInstrument — two dimensions cross-tabulated, where every cell is two
 * filters.
 *
 * ## Why a grid rather than another chart
 *
 * The filter menu already answers "how many memories carry this value" — that is
 * what its drill-down counts are. What it cannot answer is which values
 * CO-OCCUR: that a storybook problem recurs in three repositories, or that one
 * host writes nothing but signals. That question is two-dimensional, so the
 * control is a grid, and reading it is the whole of its value.
 *
 * ## Every cell is an input
 *
 * Clicking a cell calls `onSelectCell`, which writes the two ordinary filter
 * pills the cell stands for. Nothing here holds selection state of its own: the
 * ringed cells are derived from the filter bar on the way back in, so the grid
 * and the pills can never disagree, and the Back button undoes a cell click the
 * same way it undoes a pill.
 *
 * ## The counts are drilled down, and both axes are self-excluded
 *
 * `POST /memories/pivot` (migration 00090) counts each pair with every OTHER
 * active filter applied but not the two axes' own. That asymmetry is the reason
 * the grid stays usable: counted under its own axes, clicking a cell would drive
 * every other cell to zero and the instrument would have exactly one click in
 * it. Here the numbers keep meaning "what would selecting this cell yield", so
 * you can move around the grid.
 *
 * ## Colour
 *
 * A sequential single-hue ramp — one hue, light to dark, never a rainbow — read
 * from the amber scale so it sits inside the product's palette. An EMPTY cell is
 * the panel ground, not the ramp's first step: "none" and "few" must not look
 * alike. Count is never carried by colour alone — every cell's `aria-label`
 * names both values and the number, and the hovered/focused cell shows them as
 * text.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  MATRIX_AXES,
  buildMatrixGrid,
  cellKey,
  heatStep,
  type AxisOption,
} from '@/lib/explorer-instruments';
import type { Filter, FilterField } from '@/lib/filters';
import type { PivotCell } from '@lorekit/schemas/memory';

/**
 * The sequential ramp, dimmest to brightest.
 *
 * Hand-stepped rather than an opacity sweep over one token: an alpha ramp over
 * the panel's own background loses contrast against it at the low end, which is
 * exactly where most of a skewed distribution sits.
 */
const HEAT = [
  '#241a0c',
  '#4d380f',
  '#7d5a14',
  '#ab7a1a',
  '#d9a02a',
  '#f5b942',
] as const;

/** The ground for a pair no memory carries. Deliberately off the ramp. */
const EMPTY_CELL = 'var(--color-bg-elevated)';

function axisFor(field: FilterField): AxisOption {
  const found = MATRIX_AXES.find((a) => a.field === field);
  // MATRIX_AXES is derived from FILTER_FIELDS and the caller's value comes from
  // the same union, so this is unreachable — but falling back beats throwing
  // inside a render if the two ever diverge.
  return found ?? MATRIX_AXES[0]!;
}

/** Values a dimension is already filtered to, for the selected-cell ring. */
function selectedValues(filters: readonly Filter[], field: FilterField): Set<string> {
  const active = filters.find((f) => f.field === field && f.operator !== 'nin');
  return new Set(active?.values ?? []);
}

interface MatrixInstrumentProps {
  row: FilterField;
  col: FilterField;
  onRowChange: (field: FilterField) => void;
  onColChange: (field: FilterField) => void;
  cells: readonly PivotCell[];
  /** Whether the endpoint itself cut the response. */
  serverTruncated: boolean;
  isLoading: boolean;
  isError: boolean;
  /** The live filter bar — drives the selected-cell rings. */
  filters: readonly Filter[];
  /** Writes the two pills the cell stands for. */
  onSelectCell: (row: { field: FilterField; value: string }, col: { field: FilterField; value: string }) => void;
}

export function MatrixInstrument({
  row,
  col,
  onRowChange,
  onColChange,
  cells,
  serverTruncated,
  isLoading,
  isError,
  filters,
  onSelectCell,
}: MatrixInstrumentProps) {
  const reduceMotion = useReducedMotion();
  // The readout for the pointed-at cell. Hover is a desktop affordance, so the
  // same state is set on FOCUS — a keyboard walk of the grid reads the same
  // numbers a mouse does — and on touch the tap that selects also sets it.
  const [readout, setReadout] = useState<string | null>(null);

  const rowAxis = axisFor(row);
  const colAxis = axisFor(col);
  const grid = buildMatrixGrid(cells, { truncated: serverTruncated });

  const selectedRows = selectedValues(filters, row);
  const selectedCols = selectedValues(filters, col);

  const axisSelect = (
    id: string,
    label: string,
    value: FilterField,
    onChange: (f: FilterField) => void,
    other: FilterField,
  ) => (
    <label htmlFor={id} className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-content-tertiary)]">
        {label}
      </span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as FilterField)}
        className="min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-content-primary)] focus:border-[var(--color-accent)] focus:outline-none"
      >
        {MATRIX_AXES.map((a) => (
          // Both axes on one dimension is a legitimate question (that
          // dimension's diagonal), so the other axis's value is offered rather
          // than disabled.
          <option key={a.field} value={a.field}>
            {a.label}
            {a.field === other ? ' (same)' : ''}
          </option>
        ))}
      </select>
    </label>
  );

  const body = () => {
    if (isLoading) {
      return (
        <div className="flex min-h-[180px] items-center justify-center gap-2 text-xs text-[var(--color-content-tertiary)]" role="status">
          <Loader2 className={`size-4 ${reduceMotion ? '' : 'animate-spin'}`} aria-hidden />
          Counting intersections…
        </div>
      );
    }
    if (isError) {
      return (
        <p className="flex min-h-[180px] items-center justify-center px-4 text-center text-xs text-[var(--color-content-secondary)]">
          Could not load the matrix. The list below is unaffected.
        </p>
      );
    }
    if (grid.rows.length === 0) {
      return (
        <p className="flex min-h-[180px] items-center justify-center px-4 text-center text-xs text-[var(--color-content-tertiary)]">
          No memories carry both of these dimensions under the current filters.
        </p>
      );
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px] text-left">
          <caption className="sr-only">
            {rowAxis.label} by {colAxis.label}: how many memories carry each pair of values.
            Selecting a cell filters the list to that pair.
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{rowAxis.label}</span>
              </th>
              {grid.cols.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="max-w-[92px] align-bottom text-[10px] font-normal text-[var(--color-content-tertiary)]"
                >
                  {/* Vertical so a column stays narrow enough to fit a phone.
                      `title` carries the untruncated value. */}
                  <span
                    title={c}
                    className="block h-[86px] [writing-mode:vertical-rl] overflow-hidden text-ellipsis whitespace-nowrap"
                  >
                    {c}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => (
              <tr key={r}>
                <th
                  scope="row"
                  title={r}
                  className="max-w-[132px] overflow-hidden text-ellipsis whitespace-nowrap pr-2 text-right text-[11px] font-normal text-[var(--color-content-secondary)]"
                >
                  {r}
                </th>
                {grid.cols.map((c) => {
                  const count = grid.counts.get(cellKey(r, c)) ?? 0;
                  const step = heatStep(count, grid.max, HEAT.length);
                  const isSelected = selectedRows.has(r) && selectedCols.has(c);
                  const describe = `${rowAxis.label} ${r}, ${colAxis.label} ${c}: ${count} ${count === 1 ? 'memory' : 'memories'}`;
                  return (
                    <td key={c} className="p-0">
                      <button
                        type="button"
                        // A cell with nothing in it is not a filter worth
                        // offering: selecting it would empty the list.
                        disabled={count === 0}
                        onClick={() =>
                          onSelectCell({ field: row, value: r }, { field: col, value: c })
                        }
                        onPointerEnter={() => setReadout(describe)}
                        onPointerLeave={() => setReadout(null)}
                        onFocus={() => setReadout(describe)}
                        onBlur={() => setReadout(null)}
                        aria-label={describe}
                        aria-pressed={isSelected}
                        title={describe}
                        // 28px tall: above the repo's 24px hit-target floor with
                        // room for the 2px grid gap, so the grid stays tappable
                        // on a phone rather than needing a separate mobile mode.
                        className={[
                          'block h-7 w-full min-w-[28px] rounded-[3px] transition-colors duration-150',
                          count === 0
                            ? 'cursor-default'
                            : 'cursor-pointer hover:outline hover:outline-1 hover:outline-[var(--color-content-primary)]',
                          isSelected
                            ? 'outline outline-2 -outline-offset-1 outline-[var(--color-accent)]'
                            : '',
                        ].join(' ')}
                        style={{ background: step < 0 ? EMPTY_CELL : HEAT[step] }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {axisSelect('matrix-row', 'Rows', row, onRowChange, col)}
        {axisSelect('matrix-col', 'Columns', col, onColChange, row)}
      </div>

      {body()}

      {/* The scale, plus the live readout for the pointed-at cell — so the
          number is never carried by colour alone. `aria-live` is off: the cell's
          own label already announces it on focus, and echoing it here would say
          everything twice. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] text-[var(--color-content-tertiary)]">
        <span className="flex items-center gap-1.5">
          <span>0</span>
          <span className="flex h-[7px] w-[72px] overflow-hidden rounded-sm">
            {HEAT.map((c) => (
              <span key={c} className="flex-1" style={{ background: c }} />
            ))}
          </span>
          <span>{grid.max}</span>
        </span>
        <span aria-hidden>·</span>
        <span>{readout ?? 'Select a cell to filter on both dimensions'}</span>
        {grid.truncated && (
          <>
            <span aria-hidden>·</span>
            {/* Never let a cap read as "those pairs do not exist". */}
            <span>showing the densest values only</span>
          </>
        )}
      </div>
    </div>
  );
}
