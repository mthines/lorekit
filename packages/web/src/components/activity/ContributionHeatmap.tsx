'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';

interface DayData {
  date: string; // YYYY-MM-DD
  count: number;
}

interface ContributionHeatmapProps {
  data: DayData[];
  weeks?: number;
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

export function ContributionHeatmap({ data, weeks = 26 }: ContributionHeatmapProps) {
  const { grid, monthLabels, maxCount } = useMemo(() => {
    const today = new Date();

    // Anchor the grid so its LAST column is the current week (the one that
    // contains today). Previously the grid was anchored to `today - weeks*7`
    // and snapped backward to a Monday, which made it end ~a week before today
    // — so lessons written this week fell past the final cell and never showed.
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
    let seenMonths = new Set<string>();

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

    // Drop a month label when the next one is within MIN_LABEL_GAP columns.
    // This happens when the grid starts (or ends) mid-month — e.g. a 1-week
    // sliver of January sitting directly under February's label, which then
    // overlap since each column is only ~13px wide. We keep the later, more
    // representative label (Feb over the January sliver).
    const MIN_LABEL_GAP = 3;
    const monthLabels = months.filter((m, i) => {
      const next = months[i + 1];
      return !next || next.col - m.col >= MIN_LABEL_GAP;
    });

    return { grid: cols, monthLabels, maxCount: max };
  }, [data, weeks]);

  return (
    <div className="select-none" aria-label="Contribution heatmap">
      {/* Month labels */}
      <div className="relative mb-1 h-4" aria-hidden>
        {monthLabels.map(({ label, col }) => (
          <span
            key={`${label}-${col}`}
            className="absolute text-xs text-[var(--color-content-tertiary)]"
            style={{ left: `${col * 13}px` }}
          >
            {label}
          </span>
        ))}
      </div>

      <div className="flex gap-0.5">
        {/* Day labels */}
        <div className="mr-1 flex flex-col gap-0.5" aria-hidden>
          {DAYS.map((day, i) => (
            <span
              key={i}
              className="flex h-[11px] items-center text-[10px] text-[var(--color-content-tertiary)]"
              style={{ lineHeight: '11px' }}
            >
              {day}
            </span>
          ))}
        </div>

        {/* Grid */}
        <div className="flex gap-0.5">
          {grid.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-0.5">
              {week.map(({ date, count }) => {
                const intensity = getIntensity(count, maxCount);
                return (
                  <motion.div
                    key={date}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      delay: wi * 0.008,
                      duration: 0.2,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    title={count > 0 ? `${count} lesson${count > 1 ? 's' : ''} on ${date}` : date}
                    className={[
                      'size-[11px] rounded-[2px] border transition-all duration-100 hover:scale-125',
                      INTENSITY_STYLES[intensity],
                    ].join(' ')}
                    role="img"
                    aria-label={`${date}: ${count} lessons`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend — the scale runs from 0 lessons (empty) to the busiest day. */}
      <div
        className="mt-2 flex items-center gap-1.5"
        aria-label={`Scale from 0 to ${maxCount} lesson${maxCount === 1 ? '' : 's'} per day`}
      >
        <span className="text-[10px] text-[var(--color-content-tertiary)]" aria-hidden>
          0
        </span>
        {([0, 1, 2, 3, 4] as const).map((i) => (
          <div
            key={i}
            className={`size-[11px] rounded-[2px] border ${INTENSITY_STYLES[i]}`}
            aria-hidden
          />
        ))}
        <span className="text-[10px] text-[var(--color-content-tertiary)]" aria-hidden>
          {maxCount}
        </span>
        <span className="ml-1 text-[10px] text-[var(--color-content-tertiary)]" aria-hidden>
          lessons / day
        </span>
      </div>
    </div>
  );
}
