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

import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Info, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
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
  /**
   * A second, quieter figure shown under the caption — for a card that carries
   * two related counts (the Explorer's Lifecycle card pairs archived with
   * expired). It is part of the ANSWER, so it stays visible at both densities;
   * it renders below the caption as "<value> <label>", never as a chart.
   */
  secondary?: { label: string; value: number };
  /**
   * Opt this card into the two-density morph used by the Lore Explorer's
   * collapsible insights panel. OFF by default, so every OTHER caller (the
   * Overview) renders the card exactly as before — a `collapsible` card gets an
   * animated reveal region that a plain one never mounts, so the two share one
   * component without the Overview inheriting the Explorer's collapse machinery.
   */
  collapsible?: boolean;
  /**
   * When {@link collapsible}, whether the card is in its compact state — the
   * icon, tag, number, label and caption stay put (the ANSWER), and only the
   * evidence that needs room (the trend chip and the sparkbar) folds away.
   * Ignored unless `collapsible` is set.
   */
  collapsed?: boolean;
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
  secondary,
  collapsible = false,
  collapsed = false,
}: StatCardProps) {
  // Two points minimum: a chip comparing a single bucket against nothing is a
  // number with no meaning. Built once (narrowing `trend`/`trendTitle` here) so
  // both the plain and collapsible paths share it without a non-null assertion.
  const chip =
    trend && trend.points.length >= 2 && trendTitle ? (
      <TrendChip changePct={trend.changePct} title={trendTitle} />
    ) : null;

  const iconBox = (
    <div className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <Icon className="size-4 text-[var(--color-accent)]" aria-hidden />
    </div>
  );

  // The headline is the card's focal point and is sized to say so — the tag, the
  // label and the caption around it are all ≤12px, so the number carries the
  // hierarchy on its own without a second accent. It steps up again on `sm` and
  // above, where the cards are 2- or 4-up and each one is narrow enough that the
  // number has to win the column at a glance. It COUNTS to a new value rather
  // than swapping: see AnimatedNumber for why that is a change indicator.
  const numberBlock = (
    <div>
      <p className="text-2xl font-bold leading-tight tabular-nums text-[var(--color-content-primary)] sm:text-3xl">
        <AnimatedNumber value={value} />
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
      {secondary && (
        <p className="mt-1.5 text-[11px] text-[var(--color-content-tertiary)]">
          <span className="font-semibold tabular-nums text-[var(--color-content-secondary)]">
            <AnimatedNumber value={secondary.value} />
          </span>{' '}
          {secondary.label}
        </p>
      )}
    </div>
  );

  const sparkbar = trend && (
    <Sparkbar
      points={trend.points}
      unit={unit}
      className="mt-auto h-7 w-full"
      ariaLabel={rangeTitle ? `${label}: ${rangeTitle}` : label}
    />
  );

  // ── Collapsible: the same card at two densities ─────────────────────────────
  // Only the Lore Explorer's insights panel passes `collapsible`. The icon, tag,
  // number, label and caption never move between the two densities — they are the
  // answer, and the answer should stay put. It is the EVIDENCE that folds: the
  // trend chip fades in place (top-right, no reflow) and the sparkbar unfolds its
  // own height. Because it is ONE card growing rather than a strip cross-fading
  // into a different card, the expand reads as a single motion, not a swap.
  if (collapsible) {
    return <CollapsibleStatCard
      iconBox={iconBox}
      tag={tag}
      numberBlock={numberBlock}
      sparkbar={sparkbar}
      chip={chip}
      collapsed={collapsed}
    />;
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {iconBox}
          <UnitTag label={tag} />
        </div>
        {chip}
      </div>
      {numberBlock}
      {/* Per-metric trend — hover (desktop) or tap (mobile) a bar for values. */}
      {sparkbar}
    </div>
  );
}

/**
 * The collapsible rendering of {@link StatCard}, split out so the plain card's
 * markup stays untouched (and its Overview baseline with it).
 *
 * Spacing is `mt-3` rather than the plain card's `flex … gap-3` deliberately:
 * the reveal's own gap lives INSIDE its animated height, so when the sparkbar
 * folds away its spacing folds with it — a flex `gap` between the number block
 * and the reveal would leave a 12px orphan that snaps shut on unmount.
 */
function CollapsibleStatCard({
  iconBox,
  tag,
  numberBlock,
  sparkbar,
  chip,
  collapsed,
}: {
  iconBox: ReactNode;
  tag: string;
  numberBlock: ReactNode;
  sparkbar: ReactNode;
  chip: ReactNode;
  collapsed: boolean;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {iconBox}
          <UnitTag label={tag} />
        </div>
        {/* The chip carries no layout of its own (the row is space-between), so
            it can just fade — no height to animate, no reflow of the number. */}
        <motion.div
          animate={{ opacity: collapsed ? 0 : 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          aria-hidden={collapsed}
        >
          {chip}
        </motion.div>
      </div>
      <div className="mt-3">{numberBlock}</div>
      <AnimatePresence initial={false}>
        {!collapsed && sparkbar && (
          <motion.div
            key="evidence"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mt-3">{sparkbar}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
