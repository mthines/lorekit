'use client';

import { useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { WeekCount } from '@/lib/queries/dashboard';

interface ActivitySparklineProps {
  data: WeekCount[];
}

/** Format "2026-W29" → "W29" for the x-axis tick labels. */
function shortWeek(week: string): string {
  return week.split('-')[1] ?? week;
}

/** Determine week-over-week trend from the last two weeks. */
function trend(data: WeekCount[]): 'up' | 'down' | 'flat' {
  if (data.length < 2) return 'flat';
  const last = data[data.length - 1]?.count ?? 0;
  const prev = data[data.length - 2]?.count ?? 0;
  if (last > prev) return 'up';
  if (last < prev) return 'down';
  return 'flat';
}

export function ActivitySparkline({ data }: ActivitySparklineProps) {
  const { bars, max, thisWeek, lastWeek } = useMemo(() => {
    const max = Math.max(...data.map((d) => d.count), 1);
    const thisWeek = data[data.length - 1]?.count ?? 0;
    const lastWeek = data[data.length - 2]?.count ?? 0;
    return { bars: data, max, thisWeek, lastWeek };
  }, [data]);

  const dir = trend(data);
  const TrendIcon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const trendColor =
    dir === 'up'
      ? 'text-[var(--color-success)]'
      : dir === 'down'
        ? 'text-[var(--color-error)]'
        : 'text-[var(--color-content-tertiary)]';

  const totalInWindow = data.reduce((s, d) => s + d.count, 0);

  // SVG dimensions
  const W = 320;
  const H = 64;
  const barW = Math.floor((W - (bars.length - 1) * 3) / bars.length);
  const gap = 3;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-[var(--color-content-tertiary)]">Weekly lessons — last 12 weeks</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
            {totalInWindow}
          </p>
          <p className="text-[10px] text-[var(--color-content-tertiary)]">lessons total in window</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className={`flex items-center gap-1 text-xs font-medium ${trendColor}`}>
            <TrendIcon className="size-3.5" aria-hidden />
            {dir === 'flat' ? 'No change' : `${Math.abs(thisWeek - lastWeek)} this week`}
          </div>
          <p className="text-[10px] text-[var(--color-content-tertiary)]">
            vs last week ({lastWeek})
          </p>
        </div>
      </div>

      {/* Bar chart */}
      <div aria-label="Weekly activity bar chart" role="img">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H + 18}`}
          preserveAspectRatio="none"
          className="overflow-visible"
        >
          {bars.map((bar, i) => {
            const x = i * (barW + gap);
            const barH = max > 0 ? Math.max(Math.round((bar.count / max) * H), bar.count > 0 ? 3 : 0) : 0;
            const y = H - barH;
            const isLast = i === bars.length - 1;

            return (
              <g key={bar.week}>
                {/* Bar */}
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH || 2}
                  rx={2}
                  className={isLast ? 'fill-[var(--color-accent)]' : 'fill-[var(--color-bg-elevated)]'}
                  style={
                    !isLast && bar.count > 0
                      ? { fill: 'var(--color-accent)', opacity: 0.3 }
                      : undefined
                  }
                />
                {/* Count tooltip on hover */}
                {bar.count > 0 && (
                  <title>{`${shortWeek(bar.week)}: ${bar.count} lesson${bar.count !== 1 ? 's' : ''}`}</title>
                )}
                {/* X-axis label — show every 4th week + current */}
                {(i % 4 === 0 || isLast) && (
                  <text
                    x={x + barW / 2}
                    y={H + 14}
                    textAnchor="middle"
                    fontSize={9}
                    className="fill-[var(--color-content-tertiary)]"
                    fontFamily="ui-monospace, monospace"
                  >
                    {shortWeek(bar.week)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
