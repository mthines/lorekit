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
 * The four cards are ALWAYS mounted — one persistent grid that {@link
 * ExplorerStats} folds to a compact density when collapsed and unfolds when
 * open. The answer (icon, number, label, caption) never moves; only the
 * evidence unfolds — each card's sparkbar grows its own height and the heatmap
 * region below animates in — so the expand reads as ONE motion rather than a
 * strip cross-fading into a different set of cards. Height + opacity so the list
 * below is seen to move rather than jump. Under `prefers-reduced-motion` both
 * collapse to an instant swap, per the repo's motion rule.
 */

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ExplorerStats } from '@/components/lore/ExplorerStats';
import { RangePicker } from '@/components/ui/RangePicker';
import type { DateRange } from '@/components/ui/DateRangePicker';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
// The span and the fetch window that must cover it live together — see the
// module for why they cannot be two numbers in two files.
import { HEATMAP_WEEKS } from '@/lib/heatmap-window';
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
  /**
   * The selection to highlight on the heatmap, as inclusive day strings.
   *
   * Derived from the caller's raw `range`, NOT from this panel's
   * {@link DEFAULT_STATS_RANGE} substitution — so on an untouched `?range=` the
   * picker reads 24h while the heatmap highlights nothing. That asymmetry is
   * correct, not an oversight: the highlight says *what the list below is
   * filtered to*, and on an untouched range the list is unfiltered. Lighting up
   * today's cell would assert a filter that is not applied, which is the one
   * thing a highlight must never do. Once a range is actually picked the two
   * agree again, because picking one narrows both.
   */
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
      {/* The title + controls, then the persistent stat grid on its own
          full-width line. Keeping the grid out of the control row is what stops
          the numbers and the range picker colliding on a phone — the old single
          wrapping row overlapped them. */}
      <div className="flex flex-col gap-3 px-4 py-3">
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

        {/* ONE persistent grid at two densities — collapsed folds each card's
            evidence away, open unfolds it. The card is never remounted, so the
            numbers stay put and the expand reads as one motion. */}
        <ExplorerStats
          scope={scope}
          filters={filters}
          range={shownRange}
          scopeLabel={scopeLabel}
          expanded={open}
          nowIso={nowIso}
        />
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
            {/* The heatmap keeps its own span deliberately: it is a range
                SELECTOR, not a reading of the selected range, so shrinking it to
                the current window would remove the very context you use to pick a
                different one. It highlights the selection instead. It is also
                ACCOUNT-WIDE and unfiltered (`heatmapData` comes from
                `useLoreData`, not the scoped stats query), so its caption says so
                rather than implying the cards' selection narrows it. */}
            <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-4">
              <p className="mb-3 text-xs font-medium text-[var(--color-content-tertiary)]">
                Memories written — last {heatmapWeeks} weeks · across every scope
              </p>
              {/* Capped and left-aligned so it reads as one more panel, not a
                  full-bleed band: fluid cells that fill a 1300px column blow up
                  to a ~250px-tall calendar on a wide screen. The cap lands the
                  desktop cell around 16px — big enough to read and tap, small
                  enough that the chart stays card-height. A phone is narrower
                  than the cap, so it still fills there. */}
              <div className="max-w-[960px]">
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
