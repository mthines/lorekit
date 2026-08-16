/**
 * The contribution heatmap's span, and the fetch window it implies.
 *
 * These two numbers have to agree, and they live in one module because when
 * they did not, the chart lied. `GET /memories/activity` defaults to a bounded
 * 200-day window (`DEFAULT_WINDOW_DAYS` in its handler, sized when the heatmap
 * was a fixed 26 weeks), and `useLoreData` called it bare. Widening the desktop
 * heatmap to a year meant ~164 days of cells that could only ever render empty
 * — not "no memories were written then", but "nobody asked" — which is the
 * worst kind of chart bug: it reads as data.
 *
 * So the RENDER span and the FETCH window derive from the same constant, and
 * the fetch is explicit rather than relying on a server-side default that was
 * sized for a different chart.
 */

const DAY_MS = 86_400_000;

/**
 * How many week columns the heatmap draws, per breakpoint.
 *
 * The cells are fluid (`ContributionHeatmap`), so the column COUNT is the only
 * thing deciding how big each one ends up. One value cannot serve both ends:
 * 52 columns on a phone are ~4px specks, and the 13 that read well there would
 * blow a desktop cell up to ~70px — a calendar, not a heatmap.
 *
 * **These land the cells below this package's ≥24px hit-target floor
 * (~15–21px), deliberately.** Clearing it would mean ~8 columns on a phone —
 * under two months, which guts the only thing the chart is for — and padding
 * the hit area instead would overlap neighbouring cells, making them
 * mis-tappable rather than easier to hit. It rests on WCAG 2.2 SC 2.5.8's
 * *Equivalent* exception: a cell's only function is setting the date range, and
 * the same range is settable from the full-size `DateRangePicker` in the
 * Explorer's control row. The cells are still more than twice the fixed 9px
 * they replaced. Revisit by lowering `mobile` if that exception stops holding —
 * i.e. if the heatmap becomes the only way to set a range.
 */
export const HEATMAP_WEEKS = { mobile: 13, desktop: 52 } as const;

/** The widest span any breakpoint renders — what the fetch has to cover. */
export const MAX_HEATMAP_WEEKS = Math.max(HEATMAP_WEEKS.mobile, HEATMAP_WEEKS.desktop);

/**
 * Slack days added to the fetch window, and why each is needed.
 *
 * The grid is anchored on the current week's MONDAY and walks back
 * `weeks - 1` weeks, so its earliest cell is up to 6 days older than
 * `weeks * 7` suggests — and the component does that arithmetic in LOCAL time
 * while the API window is UTC, which can shift the boundary another day either
 * way. Under-fetching by a day would blank the heatmap's oldest column, so the
 * slack is deliberately generous: over-fetching costs a few bucket rows,
 * under-fetching costs a visibly wrong chart.
 */
const FETCH_SLACK_DAYS = 8;

/** How far back the heatmap's activity fetch must reach. */
export const HEATMAP_FETCH_DAYS = MAX_HEATMAP_WEEKS * 7 + FETCH_SLACK_DAYS;

/**
 * The `since` bound for the heatmap's `GET /memories/activity` call.
 *
 * Clock-injected so it is pure and testable, per this package's functional-core
 * convention — the caller passes the instant rather than this reading one.
 */
export function heatmapSince(nowIso: string): string {
  return new Date(Date.parse(nowIso) - HEATMAP_FETCH_DAYS * DAY_MS).toISOString();
}
