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
 * ## One panel, two bodies, one at a time
 *
 * Merging the panels left the two charts stacked INSIDE one card: four stat cards
 * with sparkbars, then a 52-week heatmap under them. That is still two charts of
 * the same metric competing for one reader, and expanded it still pushed the list
 * below the fold. They also answer different questions — the cards answer *how
 * much, in the window I selected*; the heatmap answers *when, over the last year,
 * regardless of what I selected* — so the honest control is a switch, not a stack.
 *
 * The segmented control sits where the `Activity · <scope>` label used to. The
 * label was redundant twice over: this `<section>` is already named "Activity for
 * the current selection" for assistive tech, and every card caption already ends
 * "in <scopeLabel>". Spending the panel's most prominent slot on a duplicate of
 * both, when the panel needed somewhere to say which of two views you are in, was
 * the trade to make. See `lib/explorer-insights-view.ts`.
 *
 * ## Progressive disclosure that summarises rather than erases
 *
 * The collapsed state is not empty: it is the four numbers on a single line.
 * That is the difference between disclosure and hiding — an earlier collapse
 * removed all four figures and left a header reading "Activity", so folding the
 * panel cost you the answer to buy back the space, which is exactly why people
 * stop collapsing things. Here the ANSWER stays visible and only the EVIDENCE
 * (trends, sparkbars, the heatmap) folds away.
 *
 * That is also why the stat grid is OUTSIDE the disclosure: on `charts` the cards
 * unfold their own evidence in place, and COLLAPSED they hold the four numbers on
 * every view. So folding never costs you the answer.
 *
 * The expanded `heatmap` view is the one place the grid is absent rather than
 * compact. Keeping it there made the panel taller than the stacked layout this
 * change exists to remove — the same two-charts-in-one-card problem, one view
 * over. Picking Heatmap is a request to see the calendar, so the calendar is what
 * it shows; the numbers are one chevron away.
 *
 * ## It opens EXPANDED, and remembers if you disagree
 *
 * It used to open collapsed, because expanded meant a screen of analytics before
 * the first memory. Showing one body at a time roughly halves that, so the
 * evidence is affordable by default — and a panel whose header now advertises two
 * views is only self-explanatory if you can see what they hold.
 *
 * Both the disclosure state and the chosen view persist to `localStorage`
 * (`lib/hooks/usePersistedPreference.ts`), so a reader who prefers it folded folds
 * it once. They are NOT url-backed: a shared link should carry what you are
 * looking at, not how tall you left a panel.
 *
 * **The no-flash rule.** Until the client store has been consulted, the panel
 * renders COLLAPSED — never expanded. An expanded-then-collapsed snap is the one
 * artefact persistence must not introduce, and rendering the neutral state first
 * makes it unreachable rather than merely unlikely. In practice there is no flash
 * in either direction: `/lore` renders `LoreExplorerSkeleton` until the scope tree
 * resolves, so this panel first mounts client-side and the stored preference is
 * already known on its first paint.
 *
 * ## Motion
 *
 * The five cards (migration 00080 split "Memories read" into retrieved +
 * opened) are ALWAYS mounted — one persistent grid that {@link
 * ExplorerStats} folds to a compact density when collapsed (or when the heatmap is
 * the chosen view) and unfolds when open. The answer (icon, number, label,
 * caption) never moves; only the evidence unfolds. Height + opacity so the list
 * below is seen to move rather than jump. Under `prefers-reduced-motion` both
 * collapse to an instant swap, per the repo's motion rule.
 */

import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ExplorerStats } from '@/components/lore/ExplorerStats';
import { RangePicker } from '@/components/ui/RangePicker';
import { SegmentedControl, type SegmentedControlItem } from '@/components/ui/SegmentedControl';
import type { DateRange } from '@/components/ui/DateRangePicker';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { usePersistedPreference } from '@/lib/hooks/usePersistedPreference';
// The span and the fetch window that must cover it live together — see the
// module for why they cannot be two numbers in two files.
import { HEATMAP_WEEKS } from '@/lib/heatmap-window';
import {
  DEFAULT_INSIGHTS_OPEN,
  DEFAULT_INSIGHTS_VIEW,
  INSIGHTS_VIEWS,
  INSIGHTS_VIEW_ARIA_LABELS,
  INSIGHTS_VIEW_ICONS,
  INSIGHTS_VIEW_LABELS,
  type InsightsView,
} from '@/lib/explorer-insights-view';
import {
  PREFERENCE_KEYS,
  isResolved,
  parseBooleanPreference,
  parseEnumPreference,
  serializeBooleanPreference,
} from '@/lib/persisted-preference';
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

/** The view toggle's segments, built from the single source in `lib/explorer-insights-view.ts`. */
const VIEW_ITEMS: SegmentedControlItem<InsightsView>[] = INSIGHTS_VIEWS.map((view) => ({
  value: view,
  label: INSIGHTS_VIEW_LABELS[view],
  icon: INSIGHTS_VIEW_ICONS[view],
  // Load-bearing rather than decorative: the visible label is hidden at narrow
  // panel widths, so this is the segment's only accessible name there.
  ariaLabel: INSIGHTS_VIEW_ARIA_LABELS[view],
}));

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
  const openPref = usePersistedPreference(PREFERENCE_KEYS.explorerInsightsOpen);
  const viewPref = usePersistedPreference(PREFERENCE_KEYS.explorerInsightsView);

  // Has a client store been consulted yet? Until it has, the panel must render
  // its NEUTRAL state (collapsed) rather than its default (expanded) — see the
  // no-flash rule in the docblock.
  const resolved = isResolved(openPref.raw);
  const open = resolved && parseBooleanPreference(openPref.raw, DEFAULT_INSIGHTS_OPEN);
  const view = parseEnumPreference(viewPref.raw, INSIGHTS_VIEWS, DEFAULT_INSIGHTS_VIEW);

  // `useReducedMotionConfig`, NOT `useReducedMotion`: the latter reads only the
  // device media query and ignores `MotionConfigContext`, so a surrounding
  // `MotionConfig reducedMotion="always"` could not reach it. Storybook's preview
  // sets exactly that to collapse motion for deterministic baselines, and this
  // panel's exit animations gate an UNMOUNT (AnimatePresence) — so with the wrong
  // hook the story environment still ran a real 200ms exit, and "the heatmap is
  // gone" became a race against it rather than a fact.
  const reduceMotion = useReducedMotionConfig();
  const isMobile = useIsMobile();
  const heatmapWeeks = isMobile ? HEATMAP_WEEKS.mobile : HEATMAP_WEEKS.desktop;
  // The one substitution: an untouched `?range=` shows 24h HERE without
  // narrowing the list. Everything below reads `shownRange`, never `range`, so
  // the picker's highlight and the cards' window can never disagree.
  const shownRange = range ?? DEFAULT_STATS_RANGE;

  // The heatmap is the only body that mounts and unmounts; the cards morph in
  // place. So this is the one thing the disclosure animates.
  const showHeatmap = open && view === 'heatmap';

  return (
    <section
      aria-label="Activity for the current selection"
      // `@container` makes the panel a query container so the stat grid can size
      // its columns to the PANEL's width (see ExplorerStats' `@3xl:grid-cols-4`),
      // which is what the sidebar-agnostic four-up-when-it-fits behaviour needs.
      // The view toggle keys off the same container for its icon-only rendering.
      className="@container rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      {/* The view toggle + controls, then the persistent stat grid on its own
          full-width line. Keeping the grid out of the control row is what stops
          the numbers and the range picker colliding on a phone — the old single
          wrapping row overlapped them. */}
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          {/* `min-w-0` + `shrink` so that when three controls cannot all fit at
              phone width it is this one that gives — and it gives by dropping its
              labels to icons (`labels="wide"`), not by wrapping the row. */}
          <SegmentedControl
            label="Activity view"
            items={VIEW_ITEMS}
            value={view}
            onChange={(next) => {
              viewPref.write(next);
              // Picking a view while folded EXPANDS. Otherwise the segment lights
              // up and nothing else happens, which reads as a dead control — and
              // "show me the heatmap" is a request to see it, not to select it.
              if (!open) openPref.write(serializeBooleanPreference(true));
            }}
            labels="wide"
            className="min-w-0"
          />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <RangePicker
              value={shownRange}
              onChange={onRangeChange}
              presets={EXPLORER_PRESETS}
              nowIso={nowIso}
            />
            <button
              type="button"
              onClick={() =>
                openPref.write(serializeBooleanPreference(!open))
              }
              aria-expanded={open}
              // Only reference the detail region while it EXISTS — AnimatePresence
              // unmounts it when collapsed, so a static IDREF would dangle exactly
              // in that state.
              {...(showHeatmap ? { 'aria-controls': 'explorer-insights-detail' } : {})}
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

        {/* ONE grid at two densities — compact folds each card's evidence away,
            expanded unfolds it. The card is never remounted between those two, so
            the numbers stay put and the expand reads as one motion.

            It is absent entirely on the EXPANDED heatmap view: picking Heatmap is
            a request to see the calendar, and leaving the cards above it made the
            panel taller than the layout it replaced — the stack this change
            exists to remove, reintroduced one view over. Collapsing still keeps
            the four numbers on every view: that is the panel's summary line, and
            it is what makes a folded panel worth having. */}
        {!showHeatmap && (
          <ExplorerStats
            scope={scope}
            filters={filters}
            range={shownRange}
            scopeLabel={scopeLabel}
            expanded={open && view === 'charts'}
            nowIso={nowIso}
          />
        )}
      </div>

      {/* Mounted only once the stored preference is known, so the very first
          application of it is an instant swap rather than an animated unfold —
          `AnimatePresence initial={false}` skips the enter transition for children
          present on its OWN first render. Every later toggle animates normally. */}
      {resolved && (
        <AnimatePresence initial={false}>
          {showHeatmap && (
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
      )}
    </section>
  );
}
