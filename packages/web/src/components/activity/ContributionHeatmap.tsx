'use client';

/**
 * ContributionHeatmap — the write-activity calendar, sized to its container.
 *
 * ## Fluid, not fixed
 *
 * The cells used to be a hard `9px` with a `1px` gap, so the grid was always
 * exactly `weeks × 10px` wide however much room it had: a ~270px block pinned
 * to the left of a 1100px panel, with an `overflow-x-auto` around it in case a
 * narrow phone could not even fit that. Both failure modes came from the same
 * decision — a chart whose width is a constant cannot be responsive.
 *
 * Now the week columns are `1fr` tracks of a CSS grid and the cells take their
 * height from their own width (`aspect-square`), so the grid fills whatever it
 * is given and the cells grow with it. Nothing here picks a pixel size; the
 * CALLER picks how many weeks to show, which is the one knob that decides how
 * big a cell ends up (see `weeks`).
 *
 * That is also why the day-label gutter is its own 7-row grid stretched to the
 * cell grid's height rather than a stack of fixed-height spans: at a fluid cell
 * size there is no pixel to hard-code, so the labels have to be divided out of
 * the same box the cells produced.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';

interface DayData {
  date: string; // YYYY-MM-DD
  count: number;
}

interface ContributionHeatmapProps {
  data: DayData[];
  /**
   * How many week columns to draw.
   *
   * With fluid cells this is the DENSITY control, not just the span: 52 columns
   * in a 1100px panel is a ~19px cell, while 52 in a 300px phone would be ~4px.
   * A caller that renders at more than one breakpoint should vary it — see
   * `ExplorerInsights`, which shows a quarter on a phone and a year on a
   * desktop so both land on a comfortable, tappable cell.
   */
  weeks?: number;
  /** Currently selected date range (UTC day strings), highlighted in the grid. */
  selectedRange?: { from: string; to: string } | null;
  /** Click handler for a cell — used to drive the date-range filter. */
  onSelectDate?: (day: string) => void;
}

/**
 * The day-label gutter's width, shared by the month-label row so the two align.
 *
 * Fixed while everything to its right is fluid, deliberately: the labels are
 * fixed-size text, so a gutter that grew with the container would only add
 * whitespace between "Wed" and the grid it annotates.
 */
const GUTTER = 'w-7';

/**
 * The gap between cells, shared by all THREE grids — month labels, day gutter,
 * and the cells themselves.
 *
 * One constant because the three are only aligned while they agree: the gutter
 * divides the cell grid's height into 7 rows minus its gaps, and the month
 * labels sit on tracks that must match the cells' pitch. Three separate
 * literals would let one drift and knock the labels off their rows.
 */
const CELL_GAP = 'gap-[2px]';

/**
 * The minimum column distance between two month labels.
 *
 * A grid that starts or ends mid-month produces a sliver — e.g. one week of
 * January directly under February's label — and at a narrow cell size the two
 * overlap. Labels closer together than this are dropped, keeping the later,
 * more representative one.
 */
const MIN_LABEL_GAP = 3;

/**
 * How many columns a month label may span before it is allowed to overflow.
 *
 * Labels are placed on the SAME grid as the cells (rather than at a percentage
 * offset) so a label sits over its week column exactly, gaps included. Spanning
 * exactly {@link MIN_LABEL_GAP} is what guarantees a label can never push into
 * the next one's start — which is why this is derived from it rather than
 * being a second `3` that has to be kept in step by hand.
 */
const LABEL_SPAN = MIN_LABEL_GAP;

/**
 * How far a label at `col` may span without running off the explicit grid.
 *
 * The clamp is load-bearing, not defensive. A label on one of the final columns
 * — which happens whenever today falls in the first two weeks of a month, so
 * roughly half the time — would otherwise span past the last track, and CSS
 * grid answers that by creating IMPLICIT columns. Those are `auto`-sized and
 * take their width out of the same fixed box, so every `1fr` cell column
 * silently narrows and each month label drifts off the week it names. Nothing
 * errors; the chart just quietly stops lining up.
 */
function labelSpan(col: number, weeks: number): number {
  return Math.min(LABEL_SPAN, weeks - col);
}

const DAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getIntensity(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  const ratio = count / Math.max(max, 1);
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

const INTENSITY_STYLES: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-[var(--color-bg-elevated)] border-[var(--color-border-subtle)]',
  1: 'bg-[#f5a62330] border-[#f5a62340]',
  2: 'bg-[#f5a62360] border-[#f5a62370]',
  3: 'bg-[#f5a62390] border-[#f5a623a0]',
  4: 'bg-[var(--color-accent)] border-[var(--color-accent)]',
};

export function ContributionHeatmap({
  data,
  weeks = 26,
  selectedRange = null,
  onSelectDate,
}: ContributionHeatmapProps) {
  // Respect the OS/browser reduce-motion preference. The heatmap animates 182
  // cells on entry — skipping this gate causes discomfort for motion-sensitive
  // users. When reduceMotion is true, cells appear instantly (no scale/fade).
  const reduceMotion = useReducedMotion();

  const { grid, monthLabels, maxCount } = useMemo(() => {
    const today = new Date();

    // Anchor the grid so its LAST column is the current week (the one that
    // contains today). Previously the grid was anchored to `today - weeks*7`
    // and snapped backward to a Monday, which made it end ~a week before today
    // — so memories written this week fell past the final cell and never showed.
    //
    // Steps: find the Monday of the current week, then walk back (weeks - 1)
    // weeks to get the first column's Monday. Building `weeks` columns forward
    // then lands the final column on the current week.
    const dayOfWeek = today.getDay(); // 0 = Sun … 6 = Sat
    const toMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const start = new Date(today);
    start.setDate(today.getDate() + toMonday - (weeks - 1) * 7);

    // Build date → count map
    const countMap = new Map<string, number>();
    for (const d of data) countMap.set(d.date, d.count);

    const max = data.reduce((m, d) => Math.max(m, d.count), 0);

    // Build week columns
    const cols: Array<Array<{ date: string; count: number }>> = [];
    const months: Array<{ label: string; col: number }> = [];
    const seenMonths = new Set<string>();

    for (let w = 0; w < weeks; w++) {
      const week: Array<{ date: string; count: number }> = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        const iso = date.toISOString().slice(0, 10);
        week.push({ date: iso, count: countMap.get(iso) ?? 0 });

        // Month label
        const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
        if (d === 0 && !seenMonths.has(monthKey)) {
          seenMonths.add(monthKey);
          months.push({ label: MONTHS[date.getMonth()]!, col: w });
        }
      }
      cols.push(week);
    }

    // See MIN_LABEL_GAP — a sliver month would otherwise sit under its
    // neighbour's label and overlap it.
    const monthLabels = months.filter((m, i) => {
      const next = months[i + 1];
      return !next || next.col - m.col >= MIN_LABEL_GAP;
    });

    return { grid: cols, monthLabels, maxCount: max };
  }, [data, weeks]);

  // The week columns as ONE flat list. `grid-auto-flow: column` over 7 explicit
  // rows fills column-by-column, which is exactly the order the columns were
  // built in — so the nested render can collapse into a single grid whose tracks
  // (and therefore whose cell size) are the container's to decide.
  const cells = grid.flatMap((week, wi) => week.map((cell) => ({ ...cell, week: wi })));

  return (
    <div className="w-full select-none" aria-label="Contribution heatmap">
      {/* Month labels — placed on the SAME column tracks as the cells, so a
          label sits over its week at any cell size. (The old absolute `left:
          col * 10px` hard-coded the pitch and drifted the moment the cells
          stopped being 9px.) */}
      <div className="mb-1 flex w-full items-end gap-1" aria-hidden>
        <div className={`${GUTTER} shrink-0`} />
        <div
          className={`grid min-w-0 flex-1 ${CELL_GAP}`}
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
        >
          {monthLabels.map(({ label, col }) => (
            <span
              key={`${label}-${col}`}
              className="whitespace-nowrap text-[11px] leading-4 text-[var(--color-content-tertiary)]"
              style={{ gridColumn: `${col + 1} / span ${labelSpan(col, weeks)}` }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* `items-stretch` is load-bearing: the cell grid's height comes from its
          own aspect-square cells, and the gutter inherits it so its 7 `1fr`
          rows divide into exactly the cell rows they label. */}
      <div className="flex w-full items-stretch gap-1">
        <div
          className={`grid ${GUTTER} shrink-0 ${CELL_GAP}`}
          style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }}
          aria-hidden
        >
          {DAYS.map((day, i) => (
            <span
              key={i}
              className="flex items-center justify-end pr-1 text-[10px] leading-none text-[var(--color-content-tertiary)]"
            >
              {day}
            </span>
          ))}
        </div>

        {/* Grid — `1fr` tracks, so the cells are as large as the container
            allows and the whole chart uses its full width. */}
        <div
          className={`grid min-w-0 flex-1 ${CELL_GAP}`}
          style={{
            gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
            gridTemplateRows: 'repeat(7, auto)',
            gridAutoFlow: 'column',
          }}
        >
          {cells.map(({ date, count, week }) => {
            const intensity = getIntensity(count, maxCount);
            const inRange =
              !!selectedRange && date >= selectedRange.from && date <= selectedRange.to;
            return (
              <motion.button
                key={date}
                type="button"
                onClick={onSelectDate ? () => onSelectDate(date) : undefined}
                disabled={!onSelectDate}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { delay: week * 0.008, duration: 0.2, ease: [0.16, 1, 0.3, 1] }
                }
                title={count > 0 ? `${count} memor${count > 1 ? 'ies' : 'y'} on ${date}` : date}
                className={[
                  // Height follows width, which is the whole responsive trick —
                  // the row heights, and so the chart's total height, are
                  // derived from the container instead of declared here.
                  'aspect-square w-full rounded-[3px] border transition-transform duration-100',
                  INTENSITY_STYLES[intensity],
                  onSelectDate
                    ? 'cursor-pointer hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]'
                    : '',
                  inRange ? 'ring-1 ring-inset ring-[var(--color-accent)]' : '',
                ].join(' ')}
                aria-label={`${date}: ${count} memor${count === 1 ? 'y' : 'ies'}${inRange ? ' (selected)' : ''}`}
                aria-pressed={onSelectDate ? inRange : undefined}
              />
            );
          })}
        </div>
      </div>

      {/* Legend — the scale runs from 0 memories (empty) to the busiest day.
          Its swatches stay a fixed 9px: they are a KEY, read next to 10px text,
          not part of the grid whose size the container decides. */}
      <div
        className="mt-2 flex items-center gap-1.5"
        aria-label={`Scale from 0 to ${maxCount} memor${maxCount === 1 ? 'y' : 'ies'} per day`}
      >
        <span className="text-[10px] text-[var(--color-content-tertiary)]" aria-hidden>
          0
        </span>
        {([0, 1, 2, 3, 4] as const).map((i) => (
          <div
            key={i}
            className={`size-[9px] rounded-[2px] border ${INTENSITY_STYLES[i]}`}
            aria-hidden
          />
        ))}
        <span className="text-[10px] text-[var(--color-content-tertiary)]" aria-hidden>
          {maxCount}
        </span>
        <span className="ml-1 text-[10px] text-[var(--color-content-tertiary)]" aria-hidden>
          memories / day
        </span>
      </div>
    </div>
  );
}
