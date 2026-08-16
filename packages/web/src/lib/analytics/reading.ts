/**
 * Reading engagement — the pure core behind `ReadingTelemetry`.
 *
 * Everything here is a function of numbers: no DOM, no clock, no SDK. The
 * effects (listeners, timers, `track` calls) live in the component, which is
 * the repo's functional-core / impure-shell split (`otel-origins.ts`,
 * `auth-redirect.ts`, `filters.ts`).
 *
 * ## Why buckets AND raw milliseconds
 * `dwellMs` is the number you want to average and rank by; the bucket is the
 * label you want to `group by` in a Dash0 panel without a histogram. Both are
 * cheap, and the bucket boundaries live here so a dashboard and a check rule
 * can never disagree about what "skimmed" means.
 */

/** Which public surface the content lives on. Bounded — one value per route family. */
export type ContentType = 'blog' | 'docs' | 'learn';

/**
 * The scroll-depth milestones we report, in percent of the content element.
 *
 * Four milestones, not a continuous number: a milestone event is emitted the
 * INSTANT it is crossed, so a reader who never triggers a page-hide flush (tab
 * killed, browser crash, mobile app switch) still leaves a usable trail. The
 * end-of-page-view summary is the nice-to-have; these are the reliable signal.
 */
export const SCROLL_MILESTONES = [25, 50, 75, 100] as const;

export type ScrollMilestone = (typeof SCROLL_MILESTONES)[number];

/** Geometry of the content element relative to the document, at one instant. */
export interface ReadGeometry {
  /** Distance from the top of the DOCUMENT to the top of the content element. */
  contentTop: number;
  /** Height of the content element. */
  contentHeight: number;
  /** Current `window.scrollY`. */
  scrollY: number;
  /** Current `window.innerHeight`. */
  viewportHeight: number;
}

/**
 * How far through the CONTENT the reader has got, 0–100.
 *
 * Measured against the article element rather than the document, so the footer,
 * the CTA and the like button can't make a half-read post look finished — and
 * so a short post and a long post are on the same scale.
 *
 * The reference point is the BOTTOM of the viewport: content you have scrolled
 * past the bottom edge is content you were shown. A post shorter than the
 * viewport is therefore 100 on arrival, which is correct ("all of it was on
 * screen") but means depth alone can't distinguish it from a real read — that
 * is what `engagedMs` is for.
 */
export function readPercent({
  contentTop,
  contentHeight,
  scrollY,
  viewportHeight,
}: ReadGeometry): number {
  if (contentHeight <= 0) return 100;
  const seen = scrollY + viewportHeight - contentTop;
  return Math.min(100, Math.max(0, (seen / contentHeight) * 100));
}

/**
 * The milestones crossed by moving from `previousMax` to `percent`.
 *
 * Takes the previous MAXIMUM, not the previous value, so scrolling up and back
 * down never re-reports a milestone: each one fires at most once per page view.
 * A jump (a deep link, a TOC click, a flick scroll) reports every milestone it
 * skipped over, so the funnel stays monotonic — 25 ≥ 50 ≥ 75 ≥ 100 always.
 */
export function crossedMilestones(previousMax: number, percent: number): ScrollMilestone[] {
  return SCROLL_MILESTONES.filter((m) => m > previousMax && m <= percent);
}

/** Coarse, orderable dwell label. Prefixed so a lexical sort is a time sort. */
export type DwellBucket = '1_under_5s' | '2_5_15s' | '3_15_60s' | '4_1_3m' | '5_over_3m';

/**
 * Bucket a duration in milliseconds.
 *
 * Boundaries are reading-shaped rather than round: under 5s is a glance, under
 * 15s is a skim, a minute or more on one section is someone actually reading it.
 */
export function dwellBucket(ms: number): DwellBucket {
  if (ms < 5_000) return '1_under_5s';
  if (ms < 15_000) return '2_5_15s';
  if (ms < 60_000) return '3_15_60s';
  if (ms < 180_000) return '4_1_3m';
  return '5_over_3m';
}

/**
 * Resolve the section a reader is currently in, from live heading positions.
 *
 * The extracted, testable half of `useActiveHeading`'s resolver — shared so the
 * highlighted TOC entry and the section we bill the time to can never disagree
 * about which section that is.
 *
 * @param positions headings in DOCUMENT order, with `top` from `getBoundingClientRect`.
 * @param offset the "reading line" in px from the viewport top.
 * @param atBottom whether the page is scrolled to its end — where a short final
 *   section's heading never reaches the line, so the last item wins.
 */
export function resolveActiveHeadingId(
  positions: readonly { id: string; top: number }[],
  { offset, atBottom }: { offset: number; atBottom: boolean },
): string {
  let current = positions[0]?.id ?? '';
  for (const { id, top } of positions) {
    if (top - offset <= 0) current = id;
    else break;
  }
  if (atBottom) current = positions[positions.length - 1]?.id ?? current;
  return current;
}
