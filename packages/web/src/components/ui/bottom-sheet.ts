/**
 * BottomSheet — pure drag-dismiss decision.
 *
 * The one non-trivial decision a drag-to-close sheet makes is "does *this*
 * release close the sheet, or snap it back?". Extracting it here keeps that
 * decision testable in the Node vitest project (no browser, no motion) and lets
 * `BottomSheet.tsx` stay a thin view over `onDragEnd`. Mirrors the repo's
 * functional-core split (`tag-filter.ts`, `disclosure.ts`, `Tooltip.spec.ts`).
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
