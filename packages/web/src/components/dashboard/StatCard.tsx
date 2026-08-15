'use client';

/**
 * The shared stat-card primitives.
 *
 * These were local to `DashboardStats` until the Lore Explorer grew a stats
 * header of its own showing the same four kinds of number. Two copies of a card
 * whose whole job is to be comparable would defeat the point: the Overview's
 * "Memories written" and the Explorer's have to look and read identically, or a
 * reader cannot carry a number from one page to the other.
 *
 * Presentation only — every value, series and caption is computed by the caller
 * (`lib/aggregations.ts`, `lib/time-range.ts`), so this file has no opinion
 * about what a range is or how a bar was tallied.
 */

import { Info, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { Tooltip } from '@/components/ui/Tooltip';
import type { StatTrend } from '@/lib/aggregations';

/** The small uppercase dimension tag in a card's header. */
export function UnitTag({ label }: { label: string }) {
  return (
    <span className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
      {label}
    </span>
  );
}

/** Period-over-period change, coloured by direction. */
export function TrendChip({ changePct, title }: { changePct: number; title: string }) {
  const dir = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const color =
    dir === 'up'
      ? 'text-[var(--color-success)]'
      : dir === 'down'
        ? 'text-[var(--color-error)]'
        : 'text-[var(--color-content-tertiary)]';

  return (
    <span
      className={`flex items-center gap-1 text-xs font-medium tabular-nums ${color}`}
      title={title}
    >
      <Icon className="size-3.5" aria-hidden />
      {changePct > 0 ? `+${changePct}` : changePct}%
    </span>
  );
}

export interface StatCardProps {
  icon: LucideIcon;
  /** The metric's name, under the number. */
  label: string;
  /** The uppercase dimension tag in the header. */
  tag: string;
  /** What the number counts, and what it deliberately does not. */
  tooltip: string;
  value: number;
  /** The caption under the label — usually the range. */
  description: string;
  /**
   * The series. OPTIONAL, and its absence is a real state rather than a
   * degraded one: the Expired tile counts an event the API reports as a total
   * with no per-bucket breakdown, so there is nothing honest to draw. A card
   * with no series shows no chip either — a period-over-period comparison needs
   * two windows of the same series to compare.
   */
  trend?: StatTrend;
  /** Accessible/hover explanation of the trend chip's comparison. */
  trendTitle?: string;
  /** Unit word used in the sparkbar's per-bar readout ("memories", "scopes"). */
  unit?: string;
  /** Range title for the sparkbar's accessible name. */
  rangeTitle?: string;
}

/**
 * One stat card: an icon, a tagged header, a number with its caption, and —
 * when the metric has a series — a trend chip and a sparkbar.
 *
 * **Every card with a series is additive: summing its bars reproduces its
 * headline.** That is a property of what the caller passes in, not of this
 * component, but it is the contract the layout assumes: the bars sit directly
 * under the number precisely so the eye can check the claim.
 */
export function StatCard({
  icon: Icon,
  label,
  tag,
  tooltip,
  value,
  description,
  trend,
  trendTitle,
  unit = 'memories',
  rangeTitle,
}: StatCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
            <Icon className="size-4 text-[var(--color-accent)]" aria-hidden />
          </div>
          <UnitTag label={tag} />
        </div>
        {/* Two points minimum: a chip comparing a single bucket against nothing
            is a number with no meaning. */}
        {trend && trend.points.length >= 2 && trendTitle && (
          <TrendChip changePct={trend.changePct} title={trendTitle} />
        )}
      </div>
      <div>
        <p className="text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
          {value}
        </p>
        <p className="flex items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
          {label}
          <Tooltip content={tooltip} side="top" align="center">
            <Info
              className="size-3 shrink-0 text-[var(--color-content-tertiary)] opacity-60"
              aria-hidden
            />
          </Tooltip>
        </p>
        <p className="mt-0.5 text-[10px] text-[var(--color-content-tertiary)] opacity-70">
          {description}
        </p>
      </div>
      {/* Per-metric trend — hover (desktop) or tap (mobile) a bar for values. */}
      {trend && (
        <Sparkbar
          points={trend.points}
          unit={unit}
          className="mt-auto h-7 w-full"
          ariaLabel={rangeTitle ? `${label}: ${rangeTitle}` : label}
        />
      )}
    </div>
  );
}
