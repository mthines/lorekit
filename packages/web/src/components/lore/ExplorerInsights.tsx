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

interface ExplorerInsightsProps {
  scope: string | null;
  scopeLabel: string;
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  /**
   * The active dimension filters. Forwarded to the stat cards so Written +
   * Scopes narrow to the list's set (migration 00062) — which is why there is no
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

  return (
    <section
      aria-label="Activity for the current selection"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      {/* One header row carries the whole panel: what is being counted, over
          what window, and the single control that opens it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
          {scope ? `Activity · ${scopeLabel}` : 'Activity · all scopes'}
        </p>

        {/* The collapsed summary lives in the HEADER, not under it, so the
            panel is one row tall when closed. Cross-fading it against the cards
            is what makes the numbers appear to survive the transition. */}
        <AnimatePresence initial={false} mode="wait">
          {!open && (
            <motion.div
              key="strip"
              className="min-w-0 flex-1"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.12 }}
            >
              <ExplorerStats
                scope={scope}
                filters={filters}
                range={range}
                scopeLabel={scopeLabel}
                variant="strip"
                nowIso={nowIso}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="ml-auto flex items-center gap-2">
          <RangePicker
            value={range}
            onChange={onRangeChange}
            presets={EXPLORER_PRESETS}
            nowIso={nowIso}
          />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="explorer-insights-detail"
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
                range={range}
                scopeLabel={scopeLabel}
                variant="cards"
                nowIso={nowIso}
              />

              {/* The heatmap keeps its own 26-week span deliberately: it is a
                  range SELECTOR, not a reading of the selected range, so
                  shrinking it to the current window would remove the very
                  context you use to pick a different one. It highlights the
                  selection instead. */}
              <div className="overflow-x-auto border-t border-[var(--color-border)] pt-4">
                <p className="mb-3 text-xs font-medium text-[var(--color-content-tertiary)]">
                  Memories written — last 26 weeks
                </p>
                <ContributionHeatmap
                  data={heatmapData}
                  weeks={26}
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
