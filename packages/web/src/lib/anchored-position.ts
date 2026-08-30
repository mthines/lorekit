/**
 * Pure placement math for any surface portaled to `document.body` and anchored
 * to a trigger — the filter popover, the pill's operator listbox, and the
 * shared `Combobox`.
 *
 * The popover is portaled to `document.body` and therefore positioned
 * `fixed` — it has to be, because the trigger sits inside the Explorer's
 * `overflow-hidden` panels and its scrolling results column, and an in-flow
 * `absolute` popover is clipped by the first of those ancestors. The cost of
 * escaping them is that position is no longer inherited from the DOM; it is
 * computed here, from the trigger's rect and the viewport.
 *
 * Kept dependency-free (no React, no DOM reads — the caller passes the
 * measured rect) so the arithmetic is unit-testable in the node vitest project,
 * mirroring `bottom-sheet.ts` and `filters.ts`. The impure shell is
 * `components/lore/FilterMenu.tsx`, which measures, listens for scroll/resize,
 * and applies the result.
 */

/** Popover width in px — `w-72`, mirrored here because position is computed. */
export const POPOVER_WIDTH = 288;
/** Gap between the trigger and the popover. */
export const GAP = 6;
/** Minimum breathing room from the viewport edge. */
export const VIEWPORT_MARGIN = 8;
/** Search box + footer (+ the level-two breadcrumb) — the non-list chrome. */
export const CHROME_HEIGHT = 96;
/** The list never shrinks below this; below it the menu reads as broken. */
export const MIN_LIST_HEIGHT = 132;
/** …nor grows past it, so a long catalog scrolls instead of filling the screen. */
export const MAX_LIST_HEIGHT = 256;

/** The subset of a `DOMRect` the placement actually reads. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface AnchoredPosition {
  left: number;
  /** Set when the menu hangs below the trigger. Mutually exclusive with `bottom`. */
  top?: number;
  /** Set when the menu flips above the trigger. Mutually exclusive with `top`. */
  bottom?: number;
  /** Space available for the scrolling list, in px. */
  listMaxHeight: number;
}

/**
 * The measurements of the surface being placed.
 *
 * Every field defaults to the filter popover's own geometry, so the original
 * two-argument call is unchanged. They exist because the popover is no longer
 * the only portaled surface anchored to a trigger in this subtree: the filter
 * pill's operator listbox is a 144px, chrome-less, two-or-three-row list, and
 * placing it with a 288px width and a 96px chrome allowance would clamp it
 * away from its own trigger and flip it for room it does not need.
 */
export interface AnchoredSize {
  /** Width of the surface in px. Drives the horizontal clamp. */
  width?: number;
  /** Non-list chrome (search box, footer, padding) in px. */
  chromeHeight?: number;
  /** The list never shrinks below this. */
  minListHeight?: number;
  /** …nor grows past it. */
  maxListHeight?: number;
}

/**
 * Place the popover against its trigger.
 *
 * Three rules, each fixing something an `absolute left-0 top-full` popover
 * could not express:
 *
 * 1. **Clamp horizontally.** A trigger near the right edge would otherwise
 *    push a 288px menu off-screen. In-flow, the overflow ancestor hid that;
 *    fixed, it would be visible and unreachable.
 * 2. **Flip only when it helps.** Below is the direction the trigger implies,
 *    so it wins ties and near-ties; the menu goes above only when below cannot
 *    hold a usable list AND above has more room. A menu that flips on a few
 *    pixels of difference feels unstable.
 * 3. **Cap the list to the space that exists.** The popover no longer lives
 *    inside a scroll container that would bound it, so nothing else will.
 */
export function anchoredPosition(
  rect: AnchorRect,
  viewport: Viewport,
  size: AnchoredSize = {},
): AnchoredPosition {
  const width = size.width ?? POPOVER_WIDTH;
  const chromeHeight = size.chromeHeight ?? CHROME_HEIGHT;
  const minListHeight = size.minListHeight ?? MIN_LIST_HEIGHT;
  const maxListHeight = size.maxListHeight ?? MAX_LIST_HEIGHT;

  const left = Math.max(
    VIEWPORT_MARGIN,
    // `Math.min` can go negative on a viewport narrower than the popover; the
    // outer `Math.max` is what keeps the left edge on-screen in that case.
    Math.min(rect.left, viewport.width - width - VIEWPORT_MARGIN),
  );

  const below = viewport.height - rect.bottom - GAP - VIEWPORT_MARGIN;
  const above = rect.top - GAP - VIEWPORT_MARGIN;
  const flip = below < minListHeight + chromeHeight && above > below;
  const space = flip ? above : below;

  const listMaxHeight = Math.min(
    maxListHeight,
    Math.max(minListHeight, space - chromeHeight),
  );

  return flip
    ? { left, bottom: viewport.height - rect.top + GAP, listMaxHeight }
    : { left, top: rect.bottom + GAP, listMaxHeight };
}
