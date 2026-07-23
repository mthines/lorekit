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
    const totalDays = weeks * 7;
    const start = new Date(today);
    start.setDate(start.getDate() - totalDays + 1);

    // Normalise start to the nearest Monday
    const dayOfWeek = start.getDay();
    const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    start.setDate(start.getDate() + offset);

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

    return { grid: cols, monthLabels: months, maxCount: max };
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

      {/* Legend */}
      <div className="mt-2 flex items-center gap-1.5" aria-hidden>
        <span className="text-[10px] text-[var(--color-content-tertiary)]">Less</span>
        {([0, 1, 2, 3, 4] as const).map((i) => (
          <div key={i} className={`size-[11px] rounded-[2px] border ${INTENSITY_STYLES[i]}`} />
        ))}
        <span className="text-[10px] text-[var(--color-content-tertiary)]">More</span>
      </div>
    </div>
  );
}
