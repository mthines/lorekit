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
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { Info, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { Tooltip } from '@/components/ui/Tooltip';
import type { StatTrend } from '@/lib/aggregations';
import { formatPercentDelta, isPercentDeltaAbbreviated } from '@/lib/format-number';

/** The small uppercase dimension tag in a card's header. */
export function UnitTag({ label }: { label: string }) {
  return (
    <span className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
      {label}
    </span>
  );
}

/**
 * Period-over-period change, coloured by direction.
 *
 * ## Large deltas ABBREVIATE
 *
 * The chip shares a line with the headline figure it annotates, and it carries two
 * characters the figure does not — a sign and a `%`. A young scope's first busy
 * week produces genuinely enormous percentages (a read count going from 3 to 265
 * is `+8834%`), and at seven characters the chip collided with a `22,425` beside
 * it on a desktop and was clipped at the card's edge on a phone. So the magnitude
 * abbreviates above four digits (`+8.8K%`), through the same
 * `lib/format-number.ts` vocabulary the dashboard's figures use — one meaning for
 * `K` everywhere, rather than a second abbreviation invented for one badge.
 *
 * Small deltas are untouched: `+100%` means "doubled" and is the one figure in
 * that range a reader actually reasons about.
 *
 * When something WAS dropped, the exact percentage stays reachable two ways: in
 * the hover title, and as an `sr-only` twin with the visible text hidden from
 * assistive tech — the same two-node pattern `AnimatedNumber` uses, for the same
 * reason. Below the threshold there is no twin, so nothing changes for the
 * overwhelming majority of chips.
 */
export function TrendChip({ changePct, title }: { changePct: number; title: string }) {
  const dir = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const color =
    dir === 'up'
      ? 'text-[var(--color-success)]'
      : dir === 'down'
        ? 'text-[var(--color-error)]'
        : 'text-[var(--color-content-tertiary)]';

  const abbreviated = isPercentDeltaAbbreviated(changePct);
  const exact = `${changePct > 0 ? '+' : ''}${changePct}%`;

  return (
    <span
      // `shrink-0 whitespace-nowrap`: the chip shares a flex row with a headline
      // figure that can be five digits wide, and a chip that shrinks or wraps
      // reads as clipped rather than as short of room.
      className={`flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums ${color}`}
      // The comparison the chip describes, prefixed with the exact figure when the
      // visible one is rounded — so hovering recovers what was dropped without a
      // second tooltip surface.
      title={abbreviated ? `${exact} — ${title}` : title}
    >
      <Icon className="size-3.5" aria-hidden />
      <span aria-hidden={abbreviated || undefined}>{formatPercentDelta(changePct)}</span>
      {abbreviated && <span className="sr-only">{exact}</span>}
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

  // A collapsed card is a DENSER card, not just a shorter one. Folding the
  // evidence away still left four tiles at full type scale filling about half a
  // phone's viewport before the first memory — so the compact state also drops the
  // icon box and the headline a step. Expanded is untouched, and so is every
  // non-collapsible caller (the Overview).
  //
  // This is the one property the two densities do NOT share: an earlier revision
  // promised the icon, number and label "never move" between them. Size is what
  // buys the space the folded state exists for, and the swap is instant rather
  // than animated, so it reads as a density change rather than a shift.
  const compact = collapsible && collapsed;

  const iconBox = (
    <div
      className={`flex ${compact ? 'size-7' : 'size-9'} shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]`}
    >
      <Icon
        className={`${compact ? 'size-3.5' : 'size-4'} text-[var(--color-accent)]`}
        aria-hidden
      />
    </div>
  );

  // The card's pieces, built once so the plain and collapsible layouts compose
  // the SAME elements — the plain card stacks them all; the collapsible card
  // keeps the focal pair (number + label) mounted and folds the rest away.
  //
  // The headline is the focal point and is sized to say so — the tag, the label
  // and the caption around it are all ≤12px, so the number carries the hierarchy
  // on its own. It COUNTS to a new value rather than swapping: see AnimatedNumber
  // for why that is a change indicator.
  const numberEl = (
    <p
      className={`font-bold leading-tight tabular-nums text-[var(--color-content-primary)] ${
        compact ? 'text-lg sm:text-xl' : 'text-2xl sm:text-3xl'
      }`}
    >
      <AnimatedNumber value={value} />
    </p>
  );
  const labelEl = (
    <p className="flex items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
      {label}
      <Tooltip content={tooltip} side="top" align="center">
        <Info
          className="size-3 shrink-0 text-[var(--color-content-tertiary)] opacity-60"
          aria-hidden
        />
      </Tooltip>
    </p>
  );
  const captionEl = (
    <p className="mt-0.5 text-[10px] text-[var(--color-content-tertiary)] opacity-70">
      {description}
    </p>
  );
  const sparkbar = trend ? (
    <Sparkbar
      points={trend.points}
      unit={unit}
      className="mt-auto h-7 w-full"
      ariaLabel={rangeTitle ? `${label}: ${rangeTitle}` : label}
    />
  ) : null;

  // ── Collapsible: a compact tile that unfolds into the full card ──────────────
  // Only the Lore Explorer's insights panel passes `collapsible`. COLLAPSED is
  // deliberately lean — the icon SITS LEFT OF THE NUMBER on one line with the
  // label beneath, so a card is barely taller than the number itself. Expanding
  // UNFOLDS the evidence in one motion: the trend chip fades in beside the number
  // (no vertical shift), and the caption + full-width sparkbar grow their own
  // height below. The icon, number and label are never REMOUNTED — they step down
  // a size in the compact state (see `compact` above), which is what makes the
  // folded grid a summary line rather than four full-scale tiles.
  if (collapsible) {
    return (
      <CollapsibleStatCard
        iconBox={iconBox}
        chip={chip}
        numberEl={numberEl}
        labelEl={labelEl}
        captionEl={captionEl}
        sparkbar={sparkbar}
        collapsed={collapsed}
      />
    );
  }

  return (
    // `data-stat-card` is the stable hook a test uses to find the card that owns
    // a label. Reaching for the rounded/border utilities instead couples the
    // assertion to styling AND to the panel `<section>`, which carries the same
    // radius — change the radius and every card resolves to the panel.
    <div
      data-stat-card
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {iconBox}
          <UnitTag label={tag} />
        </div>
        {chip}
      </div>
      <div>
        {numberEl}
        {labelEl}
        {captionEl}
      </div>
      {/* Per-metric trend — hover (desktop) or tap (mobile) a bar for values. */}
      {sparkbar}
    </div>
  );
}

/**
 * The collapsible rendering of {@link StatCard}, split out so the plain card's
 * markup stays untouched (and its Overview baseline with it).
 *
 * The icon sits LEFT OF THE NUMBER, with the label beneath — so a COLLAPSED card
 * is barely taller than the number itself (no header row, no tag). That trio is
 * always mounted. Folded away when collapsed: the trend chip (fades beside the
 * number, adding no height so the number never shifts) and the caption +
 * full-width sparkbar (each grows its own height below). Every reveal carries
 * its OWN spacing inside the animated region, so a folded piece leaves no gap.
 */
function CollapsibleStatCard({
  iconBox,
  chip,
  numberEl,
  labelEl,
  captionEl,
  sparkbar,
  collapsed,
}: {
  iconBox: ReactNode;
  chip: ReactNode;
  numberEl: ReactNode;
  labelEl: ReactNode;
  captionEl: ReactNode;
  sparkbar: ReactNode;
  collapsed: boolean;
}) {
  // `useReducedMotionConfig`, not `useReducedMotion`: only the former consults
  // `MotionConfigContext`, which is how Storybook's preview collapses motion for
  // deterministic baselines. These reveals gate an AnimatePresence UNMOUNT, so
  // with the device-only hook a story asserting "the evidence is gone" was racing
  // a real 200ms exit instead of observing a settled DOM.
  const reduceMotion = useReducedMotionConfig();

  // Height reveal for the pieces that grow the card downward (caption, sparkbar).
  // `overflow:hidden` is what lets an auto-height animation run; reduced motion
  // collapses it to an opacity swap per the repo's motion rule.
  const reveal = (children: ReactNode, key: string) => (
    <AnimatePresence initial={false}>
      {!collapsed && children && (
        <motion.div
          key={key}
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    // `data-stat-card`: the same stable test hook the plain card carries.
    <div
      data-stat-card
      className={`flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] ${
        collapsed ? 'p-3' : 'p-4'
      }`}
    >
      {/* Icon left of the number; number + label stacked to its right. */}
      <div className={`flex items-start ${collapsed ? 'gap-2' : 'gap-3'}`}>
        {iconBox}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            {numberEl}
            {/* The chip adds no vertical space (it shares the number's row), so
                the number never shifts as it fades in on expand. */}
            <AnimatePresence initial={false}>
              {!collapsed && chip && (
                <motion.div
                  key="chip"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.15 }}
                  className="shrink-0"
                >
                  {chip}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {labelEl}
          {reveal(captionEl, 'caption')}
        </div>
      </div>
      {sparkbar ? reveal(<div className="mt-3">{sparkbar}</div>, 'spark') : null}
    </div>
  );
}
