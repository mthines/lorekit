/**
 * BottomSheet — pure drag decisions.
 *
 * A drag-to-close sheet makes two non-trivial decisions, and both live here so
 * they stay testable in the Node vitest project (no browser, no motion) and
 * `BottomSheet.tsx` stays a thin view: (1) does *this* release close the sheet
 * or snap it back (`shouldDismissSheet`); (2) when a pointer gesture begins on
 * the sheet *body* rather than the handle, is it a sheet-drag or a content
 * scroll (`classifyBodyDrag`). Mirrors the repo's functional-core split
 * (`tag-filter.ts`, `disclosure.ts`, `Tooltip.spec.ts`).
 */

/** The net pointer displacement and velocity at the moment the drag ends. */
export interface SheetDragEnd {
  /** Net vertical offset in px since drag start. Positive = dragged down. */
  offsetY: number;
  /** Vertical velocity in px/s at release. Positive = moving down. */
  velocityY: number;
}

/** The two independent ways a downward gesture can dismiss the sheet. */
export interface SheetDismissThresholds {
  /** Dismiss once pulled at least this far down (px). */
  distance: number;
  /** Dismiss on a flick at least this fast downward (px/s), even if short. */
  velocity: number;
}

/**
 * Defaults tuned to feel like a native sheet: a deliberate ~1cm pull closes,
 * and a quick flick closes even before the finger has travelled far.
 */
export const DEFAULT_DISMISS_THRESHOLDS: SheetDismissThresholds = {
  distance: 96,
  velocity: 420,
};

/**
 * Whether a drag release should close the sheet.
 *
 * Only a *downward* gesture can dismiss — a pull upward (or none) always snaps
 * back, so an accidental up-drag never closes. A downward gesture closes when
 * it either travelled far enough (`distance`) or was flicked fast enough
 * (`velocity`); the two are independent so a short, fast flick still closes.
 */
export function shouldDismissSheet(
  { offsetY, velocityY }: SheetDragEnd,
  thresholds: SheetDismissThresholds = DEFAULT_DISMISS_THRESHOLDS,
): boolean {
  if (offsetY <= 0) return false;
  return offsetY >= thresholds.distance || velocityY >= thresholds.velocity;
}

/**
 * Drag-past-the-top elasticity per direction, handed straight to Motion's
 * `dragElastic`.
 *
 * `top: 0` would hard-stop the sheet at its resting position; a small non-zero
 * value instead lets it rubber-band a little way up under the finger — moving
 * far *less* than one pixel per pixel dragged — and spring back on release, the
 * over-scroll feel of a native sheet. `bottom` stays loose because a downward
 * pull is the close gesture, which `shouldDismissSheet` then judges.
 */
export const SHEET_DRAG_ELASTIC = { top: 0.16, bottom: 0.7 } as const;

/** What a pointer gesture that began on the sheet body should become. */
export type BodyDragIntent = 'pending' | 'drag' | 'scroll';

/** The state of the scroll area under the pointer, sampled as the drag moves. */
export interface BodyDragSample {
  /**
   * `scrollTop` of the nearest scrollable ancestor under the pointer, or 0 when
   * there is none (content fits, nothing to scroll).
   */
  scrollTop: number;
  /** Whether that ancestor can actually scroll vertically. */
  scrollable: boolean;
  /** Vertical displacement since pointer-down, in px. Positive = down. */
  dy: number;
  /** Movement to absorb before committing to an intent (px). */
  slop?: number;
}

/** Default slop before a body gesture commits to drag-vs-scroll. */
export const BODY_DRAG_SLOP = 6;

/**
 * Whether a gesture that started on the sheet *body* (not the handle) should
 * drive the sheet drag, defer to a content scroll, or wait for more movement.
 *
 * This is what makes "drag the content to close" coexist with a scrollable
 * body, the way native sheets do:
 *
 * - A scroll area that is **already scrolled** (`scrollTop > 0`) owns the whole
 *   gesture — the sheet never moves until the content is back at its top.
 * - From the top, a **downward** pull closes the sheet.
 * - From the top, an **upward** pull scrolls the content if there is any to
 *   scroll; with nothing to scroll it over-scrolls the sheet instead (so even a
 *   short list body rubber-bands rather than feeling dead).
 * - Below the slop the intent is still `pending` — the caller keeps sampling.
 */
export function classifyBodyDrag({
  scrollTop,
  scrollable,
  dy,
  slop = BODY_DRAG_SLOP,
}: BodyDragSample): BodyDragIntent {
  if (scrollable && scrollTop > 0) return 'scroll';
  if (Math.abs(dy) < slop) return 'pending';
  if (dy > 0) return 'drag';
  return scrollable ? 'scroll' : 'drag';
}
