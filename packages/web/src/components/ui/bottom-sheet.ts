/**
 * BottomSheet — pure drag decision + drag tuning constants.
 *
 * The one non-trivial decision a drag-to-close sheet makes is "does *this*
 * release close the sheet, or snap it back?" (`shouldDismissSheet`). Extracting
 * it here keeps it testable in the Node vitest project (no browser, no motion)
 * and lets `BottomSheet.tsx` stay a thin view. Mirrors the repo's
 * functional-core split (`tag-filter.ts`, `disclosure.ts`, `Tooltip.spec.ts`).
 * The over-scroll tuning constants live alongside it so the numbers behind the
 * sheet's feel are all in one place.
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

/**
 * How far the panel extends below the bottom of the screen, as a CSS length.
 *
 * A pull past the resting top translates the whole sheet up; without this its
 * bottom edge would lift off-screen and expose the backdrop as a gap. The panel
 * carries this much extra bottom padding (pulled back down by an equal negative
 * margin, so the visible content still sits flush at rest), which fills the
 * space for any up-drag within it. Sized comfortably above the elastic's
 * rubber-band ceiling for a normal gesture.
 */
export const OVERSCROLL_BUFFER = '10rem';
