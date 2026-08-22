/**
 * The Lore Explorer's Activity panel has TWO bodies, and shows one at a time.
 *
 * ## Why one at a time
 *
 * The panel used to stack both: four stat cards with sparkbars, and beneath them
 * a 52-week contribution heatmap. Two charts of the same metric, one above the
 * other, in a panel that sits above the thing the page is actually for. Expanding
 * it pushed the memory list below the fold, so the affordance people reached for
 * was "collapse", which costs them both.
 *
 * They also answer different questions. The cards answer *how much, in the window
 * I selected, and is that more or less than before*. The heatmap answers *when,
 * over the last year, regardless of my selection* — it is deliberately unscoped
 * and unfiltered, because it is a range SELECTOR you use to pick a window, not a
 * reading of the window you already picked. Two different questions is exactly
 * the case a segmented control is for: it says "there are two views here, you are
 * in this one", which stacking never says.
 *
 * Pure, so the union, its labels and its icons have ONE source — the same
 * union-metadata split `lib/status-filter.ts` follows. A view added here shows up
 * in the control with its label and icon already agreed; there is no second list
 * to forget.
 */

import { BarChart3, CalendarDays } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Which body the panel shows when it is expanded. */
export type InsightsView = 'charts' | 'heatmap';

/** In control order: the selection-aware view first, the historical one second. */
export const INSIGHTS_VIEWS: readonly InsightsView[] = ['charts', 'heatmap'] as const;

/**
 * The view a reader who has never chosen one lands on.
 *
 * `charts`, because it is the view that answers a question about the CURRENT
 * selection — which is what the scope chips, the filter bar and the range picker
 * above and beside it have just been used to express. The heatmap ignores all
 * three by design, so opening on it would make the panel look unresponsive to
 * every control around it.
 */
export const DEFAULT_INSIGHTS_VIEW: InsightsView = 'charts';

/**
 * Whether the panel starts expanded.
 *
 * `true`. It opened COLLAPSED while it showed both bodies at once, where expanded
 * meant a screen of analytics before the first memory. Showing one body at a time
 * roughly halves that, which is what makes the evidence affordable by default —
 * and a panel labelled with its two views is only self-explanatory if you can see
 * what they contain. The choice is remembered per viewer
 * (`lib/hooks/usePersistedPreference.ts`), so this is the value for someone who
 * has never expressed a preference, not a value anyone is stuck with.
 */
export const DEFAULT_INSIGHTS_OPEN = true;

/** The segment label for each view. Terse — the control sits in a dense row. */
export const INSIGHTS_VIEW_LABELS: Record<InsightsView, string> = {
  charts: 'Stat charts',
  heatmap: 'Heatmap',
};

/**
 * The accessible name for each segment.
 *
 * Longer than the visible label, because the label is what fits in a dense
 * toolbar while this is what a screen reader reads out — and because the visible
 * label disappears entirely at phone width, where the segment is icon-only.
 */
export const INSIGHTS_VIEW_ARIA_LABELS: Record<InsightsView, string> = {
  charts: 'Show stat charts',
  heatmap: 'Show the write heatmap',
};

/** The icon on each segment — the only thing shown at phone width. */
export const INSIGHTS_VIEW_ICONS: Record<InsightsView, LucideIcon> = {
  charts: BarChart3,
  heatmap: CalendarDays,
};

/** Narrowing guard for a value arriving from outside the app (e.g. storage). */
export function isInsightsView(value: unknown): value is InsightsView {
  return typeof value === 'string' && (INSIGHTS_VIEWS as readonly string[]).includes(value);
}
