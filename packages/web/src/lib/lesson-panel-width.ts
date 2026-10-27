/**
 * The memory detail panel's width — the pure half.
 *
 * On desktop the panel is a right-side drawer the reader can widen or narrow by
 * dragging its left edge. Two requirements shape everything here:
 *
 * 1. **The bounds follow the screen.** A floor and a ceiling in pixels would be
 *    wrong at one end of the monitor range or the other: a ceiling that leaves
 *    room for the list on a 1440px laptop is needlessly tight on a 3440px
 *    ultrawide. So both bounds are fractions of the viewport, with an absolute
 *    floor so the panel never gets too narrow to read.
 * 2. **The choice scales when the screen changes.** The stored preference is a
 *    FRACTION of the viewport, not a pixel width. A reader who widens the panel
 *    to 900px on a 2560px monitor gets about 506px on a 1440px laptop and their
 *    900px back when they return — the same share of the screen, rather than a
 *    pixel width that is huge on the small screen or lost on the big one.
 *
 * The rendered width is a CSS `clamp()` ({@link panelWidthCss}), so a window
 * resize or a move between monitors re-resolves it in the browser with no
 * JavaScript and no re-render. Every function here mirrors that same formula, so
 * what the resize handle reports (`aria-valuenow`) and stores is exactly what the
 * browser draws.
 */

/** The narrowest the panel ever gets, whatever the screen. */
export const PANEL_MIN_WIDTH_PX = 320;

/** The floor also grows with the screen: never under this share of it. */
export const PANEL_MIN_VIEWPORT_FRACTION = 0.15;

/** The panel never covers more than this share of the screen. */
export const PANEL_MAX_VIEWPORT_FRACTION = 0.7;

/**
 * The width before the reader has chosen one. It is the panel's historical
 * width (`max-w-lg`), so a reader who never drags the edge sees the panel they
 * always did — except on screens wider than ~3413px, where the 15vw floor
 * (`PANEL_MIN_VIEWPORT_FRACTION`) is wider than 512px and lifts it (516px at
 * 3440px).
 */
export const PANEL_DEFAULT_WIDTH_PX = 512;

/** One arrow-key press on the resize handle. */
export const PANEL_KEYBOARD_STEP_PX = 32;

/** One arrow-key press with Shift held. */
export const PANEL_KEYBOARD_LARGE_STEP_PX = 128;

export interface PanelWidthBounds {
  min: number;
  max: number;
}

/**
 * The allowed width range, in pixels, for a viewport this wide.
 *
 * `max` never drops below `min`: CSS `clamp()` lets the minimum win when the two
 * cross, and this has to agree with what the browser draws. They only cross
 * under ~457px, where the panel is a bottom sheet anyway.
 */
export function panelWidthBounds(viewportWidth: number): PanelWidthBounds {
  const min = Math.max(PANEL_MIN_WIDTH_PX, viewportWidth * PANEL_MIN_VIEWPORT_FRACTION);
  const max = Math.max(min, viewportWidth * PANEL_MAX_VIEWPORT_FRACTION);
  return { min, max };
}

/** `widthPx` held inside the bounds for this viewport. */
export function clampPanelWidth(widthPx: number, viewportWidth: number): number {
  const { min, max } = panelWidthBounds(viewportWidth);
  return Math.min(max, Math.max(min, widthPx));
}

/**
 * The width the panel renders at for a stored fraction (or `null`: nothing
 * stored, so the default), in pixels.
 */
export function panelWidthPx(fraction: number | null, viewportWidth: number): number {
  const preferred = fraction === null ? PANEL_DEFAULT_WIDTH_PX : fraction * viewportWidth;
  return clampPanelWidth(preferred, viewportWidth);
}

/**
 * The fraction to store for a width the reader dragged to.
 *
 * Clamped first, so a drag past either bound stores the bound rather than a
 * value that only CSS keeps in check. Rounded to four places — 0.01% of a 4K
 * screen is well under a pixel, and the stored string stays short.
 */
export function panelFractionFromWidth(widthPx: number, viewportWidth: number): number {
  // No measurable viewport: 0 is the one fraction `parseFractionPreference`
  // rejects, so even if it were stored it would read back as the default.
  if (viewportWidth <= 0) return 0;
  const fraction = clampPanelWidth(widthPx, viewportWidth) / viewportWidth;
  return Math.round(fraction * 10_000) / 10_000;
}

/**
 * The panel's CSS `width` for a stored fraction (or `null` for the default).
 *
 * The bounds are expressed in `vw` here as well, so the browser re-resolves them
 * on every resize. The resize handle writes this same string to the element
 * while dragging, so the drag and the committed render can never disagree.
 */
export function panelWidthCss(fraction: number | null): string {
  const preferred =
    fraction === null ? `${PANEL_DEFAULT_WIDTH_PX}px` : `${roundTo(fraction * 100, 2)}vw`;
  const minVw = roundTo(PANEL_MIN_VIEWPORT_FRACTION * 100, 2);
  const maxVw = roundTo(PANEL_MAX_VIEWPORT_FRACTION * 100, 2);
  return `clamp(max(${PANEL_MIN_WIDTH_PX}px, ${minVw}vw), ${preferred}, ${maxVw}vw)`;
}

/**
 * The width a drag asks for: the width when the drag started, plus however far
 * the pointer has moved LEFT since (the panel is anchored to the right edge, so
 * moving left widens it).
 *
 * Relative to the start rather than computed from the pointer's position in the
 * viewport, so the edge does not jump to the cursor on the first move (the
 * handle is 24px wide and can be grabbed anywhere in it), and so it holds under
 * a transformed ancestor or a classic scrollbar, where "viewport width minus
 * pointer x" is not the panel's width. Unclamped — the caller clamps when it
 * turns the width into a stored fraction.
 */
export function dragPanelWidth(startWidthPx: number, startX: number, clientX: number): number {
  return startWidthPx + (startX - clientX);
}

/**
 * The width a key press on the resize handle asks for, or `null` when the key
 * does not resize.
 *
 * Follows the WAI-ARIA window-splitter pattern for a panel on the RIGHT: moving
 * the splitter left (`ArrowLeft`) widens the panel, `Home` gives the panel its
 * smallest size and `End` its largest.
 */
export function keyboardPanelWidth(
  key: string,
  options: { shiftKey: boolean },
  currentWidthPx: number,
  viewportWidth: number,
): number | null {
  const step = options.shiftKey ? PANEL_KEYBOARD_LARGE_STEP_PX : PANEL_KEYBOARD_STEP_PX;
  const { min, max } = panelWidthBounds(viewportWidth);
  switch (key) {
    case 'ArrowLeft':
      return clampPanelWidth(currentWidthPx + step, viewportWidth);
    case 'ArrowRight':
      return clampPanelWidth(currentWidthPx - step, viewportWidth);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}

/** The share of the viewport a width covers, as a whole percentage. */
export function viewportPercent(widthPx: number, viewportWidth: number): number {
  if (viewportWidth <= 0) return 0;
  return Math.round((widthPx / viewportWidth) * 100);
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
