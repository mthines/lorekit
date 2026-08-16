'use client';

/**
 * ExplorerInsights — one panel for everything the Explorer says ABOUT the
 * memories, above the list of the memories themselves.
 *
 * ## The problem it solves
 *
 * The Explorer had grown four stacked bordered cards before a reader reached a
 * single memory: a stats panel, a heatmap panel, a view-mode tab strip, and the
 * results. Four equal-weight boxes with four headers and two independent
 * chevrons — no focal point, nothing saying where to start, and on a laptop the
 * list began below the fold. Adding the stats made the page more capable and
 * harder to read at the same time.
 *
 * Two panels become one, with ONE disclosure control, and the analytics stop
 * competing with the thing the page is for.
 *
 * ## Progressive disclosure that summarises rather than erases
 *
 * The collapsed state is not empty: it is the four numbers on a single line.
 * That is the difference between disclosure and hiding — the old collapse
 * removed all four figures and left a header reading "Activity", so folding the
 * panel cost you the answer to buy back the space, which is exactly why people
 * stop collapsing things. Here the ANSWER stays visible and only the EVIDENCE
 * (trends, sparkbars, the heatmap) folds away.
 *
 * It therefore opens COLLAPSED. The page's job is browsing lore; the numbers
 * are context, and context should be a line, not a screen, until asked for.
 *
 * ## Motion
 *
 * The expansion animates height and opacity so the list below is seen to move
 * rather than jumping — a 240px shift with no transition reads as a layout bug.
 * The strip cross-fades against the cards so the numbers appear to persist
 * across the change, which is what makes the two states read as one panel at
 * two densities rather than two different panels. Under `prefers-reduced-motion`
 * both collapse to an instant swap, per the repo's motion rule.
 */

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ExplorerStats } from '@/components/lore/ExplorerStats';
import { RangePicker } from '@/components/ui/RangePicker';
import type { DateRange } from '@/components/ui/DateRangePicker';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import type { RangePreset, TimeRange } from '@/lib/time-range';
import type { Filter } from '@/lib/filters';

/**
 * The Explorer's presets.
 *
 * The first three are the Overview's, exactly — that is the consistency the two
 * pages needed. `All` is the Explorer's own: a list can show everything, and
 * browsing everything is what people come here to do, so it must be one click
 * away from a default that deliberately is not.
 */
const EXPLORER_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', 'all'];

/**
 * What this panel describes when `?range=` is ABSENT.
 *
 * The Explorer's LIST opens on all time — that is what a list is for, and what
 * every existing `/lore` deep link (and `lorekit link` URL) has always meant by
 * an absent param. But "all time" is a poor opening question for an ACTIVITY
 * panel: a lifetime total moves so slowly that the four numbers read as
 * constants, and the trend chip and sparkbars have no window to compare.
 * So the panel opens on the last 24 hours instead — recent activity, which is
 * what someone glancing at a header labelled "Activity" is asking about.
 *
 * **This is a display default, not a filter.** It is applied HERE, to what the
 * picker and the cards are handed, and never written to `?range=` — so the list
 * below is untouched until the reader actually picks a range, at which point
 * the selection means what it has always meant and narrows both. The two states
 * are distinguishable because the picker writes `{preset:'all'}` for All rather
 * than clearing the param (see `RangePicker`): an ABSENT param is "untouched",
 * an explicit `all` is a choice, and only the first one gets substituted.
 */
const DEFAULT_STATS_RANGE: TimeRange = { preset: '24h' };

/**
 * How many week columns the heatmap draws, per breakpoint.
 *
 * The cells are fluid now (`ContributionHeatmap`), so the column COUNT is the
 * only thing deciding how big each one ends up. One value cannot serve both
 * ends: 52 columns on a phone are ~4px specks, and the 13 that read well there
 * would blow a desktop cell up to ~70px — a calendar, not a heatmap. So a
 * quarter on a phone and a year on a desktop, landing at roughly 15–21px and
 * ~19px respectively.
 *
 * **These cells sit below this package's ≥24px hit-target floor, deliberately.**
 * Clearing it would mean ~8 columns on a phone — under two months, which guts
 * the only thing the chart is for — and padding the hit area instead would
 * overlap neighbouring cells, making them mis-tappable rather than easier to
 * hit. It rests on WCAG 2.2 SC 2.5.8's *Equivalent* exception: a cell's only
 * function is setting the date range, and the same range is settable from the
 * full-size `DateRangePicker` in the control row directly below. The cells are
 * still more than twice the fixed 9px they replaced. Revisit by lowering
 * `mobile` if the exception ever stops holding — i.e. if the heatmap becomes
 * the only way to set a range.
 *
 * The data supports either span: `useLoreData` fetches `GET /memories/activity`
 * unbounded, so there is no window to widen.
 */
const HEATMAP_WEEKS = { mobile: 13, desktop: 52 } as const;

interface ExplorerInsightsProps {
  scope: string | null;
  scopeLabel: string;
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  /**
   * The active dimension filters. Forwarded to the stat cards so Written +
   * Scopes narrow to the list's set (migration 00063) — which is why there is no
   * "filters don't count" disclaimer any more.
   */
  filters: Filter[];
  /** Per-day write counts for the heatmap. */
  heatmapData: { date: string; count: number }[];
  /** The selection to highlight on the heatmap, as inclusive day strings. */
  highlightRange: DateRange | null;
  onSelectDate: (day: string) => void;
  /** One clock for the panel, so the picker and the cards describe one instant. */
  nowIso: string;
}

export function ExplorerInsights({
  scope,
  scopeLabel,
  range,
  onRangeChange,
  filters,
  heatmapData,
  highlightRange,
  onSelectDate,
  nowIso,
}: ExplorerInsightsProps) {
  // Ephemeral, like the heatmap's collapse was: a reader folding the panel away
  // is decluttering their view, not choosing something to share. Deliberately
  // NOT url-backed — a shared link should carry what you are looking at, not
  // how tall you left a panel.
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const heatmapWeeks = isMobile ? HEATMAP_WEEKS.mobile : HEATMAP_WEEKS.desktop;
  // The one substitution: an untouched `?range=` shows 24h HERE without
  // narrowing the list. Everything below reads `shownRange`, never `range`, so
  // the picker's highlight and the cards' window can never disagree.
  const shownRange = range ?? DEFAULT_STATS_RANGE;

  return (
    <section
      aria-label="Activity for the current selection"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      {/* Two rows: the title + controls, then the collapsed strip on its own
          full-width line. Keeping the strip out of the control row is what stops
          the numbers and the range picker colliding on a phone — the old single
          wrapping row overlapped them. */}
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Truncates rather than wrapping: a long scope name on a phone used
              to push the header to two lines and shove the picker down with
              it. The full name is one line below, on every card's caption. */}
          <p className="min-w-0 truncate text-xs font-medium text-[var(--color-content-tertiary)]">
            {scope ? `Activity · ${scopeLabel}` : 'Activity · all scopes'}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <RangePicker
              value={shownRange}
              onChange={onRangeChange}
              presets={EXPLORER_PRESETS}
              nowIso={nowIso}
            />
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              // Only reference the detail region while it EXISTS — AnimatePresence
              // unmounts it when collapsed, so a static IDREF would dangle exactly
              // in that state.
              {...(open ? { 'aria-controls': 'explorer-insights-detail' } : {})}
              aria-label={open ? 'Hide activity detail' : 'Show activity detail'}
              className="flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)]"
            >
              {/* One chevron that ROTATES rather than two swapped icons: the
                  rotation is the affordance, and it survives reduced motion as a
                  static direction. */}
              <motion.span
                animate={{ rotate: open ? 180 : 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.15 }}
                className="flex"
              >
                <ChevronDown className="size-4" aria-hidden />
              </motion.span>
            </button>
          </div>
        </div>

        {/* The collapsed summary — the four numbers on their own line. Cross-fades
            against the cards so the numbers appear to survive the expand. */}
        <AnimatePresence initial={false} mode="wait">
          {!open && (
            <motion.div
              key="strip"
              className="min-w-0"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.12 }}
            >
              <ExplorerStats
                scope={scope}
                filters={filters}
                range={shownRange}
                scopeLabel={scopeLabel}
                variant="strip"
                nowIso={nowIso}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="explorer-insights-detail"
            key="detail"
            // Height + opacity so the list below is SEEN to move. `overflow
            // hidden` is what makes an auto-height animation possible at all.
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="flex flex-col gap-4 px-4 pb-4">
              <ExplorerStats
                scope={scope}
                filters={filters}
                range={shownRange}
                scopeLabel={scopeLabel}
                variant="cards"
                nowIso={nowIso}
              />

              {/* The heatmap keeps its own span deliberately: it is a
                  range SELECTOR, not a reading of the selected range, so
                  shrinking it to the current window would remove the very
                  context you use to pick a different one. It highlights the
                  selection instead. It is also ACCOUNT-WIDE and unfiltered
                  (`heatmapData` comes from `useLoreData`, not the scoped stats
                  query), so its caption says so rather than implying the cards'
                  selection narrows it. */}
              {/* No `overflow-x-auto` any more: the chart sizes itself to this
                  box rather than to a fixed cell pitch, so there is nothing left
                  to scroll — it fills the panel on a desktop and fits a phone. */}
              <div className="border-t border-[var(--color-border)] pt-4">
                <p className="mb-3 text-xs font-medium text-[var(--color-content-tertiary)]">
                  Memories written — last {heatmapWeeks} weeks · across every scope
                </p>
                <ContributionHeatmap
                  data={heatmapData}
                  weeks={heatmapWeeks}
                  selectedRange={highlightRange}
                  onSelectDate={onSelectDate}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
