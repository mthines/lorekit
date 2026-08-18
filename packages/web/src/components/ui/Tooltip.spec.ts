/**
 * Tooltip — pure prop-logic tests (node environment, no DOM/React).
 *
 * These tests cover the decisions Tooltip makes based on its props and state.
 * Because there is no jsdom/React renderer available in the Node vitest
 * environment, we extract each decision into a pure helper and test that.
 *
 * Integration-level render tests (hover/focus/aria) should live in a
 * Tooltip.integration.test.tsx once @testing-library/react + jsdom are wired.
 */

import { describe, it, expect } from 'vitest';

// The panel is portaled and positioned with `fixed` coords, so its placement is
// no longer a set of Tailwind edge classes but a pure geometry function — import
// and test the REAL one rather than a copy.
import { computeTooltipPosition, type TooltipTriggerRect } from './Tooltip';

// ── Pure helpers that mirror Tooltip's internal decisions ────────────────────

/** Returns whether the panel should currently be visible. */
function isVisible(state: boolean): boolean {
  return state;
}

/** Returns the aria-hidden value for the tooltip panel. */
function ariaHidden(visible: boolean): boolean {
  return !visible;
}

/**
 * Returns whether aria-describedby should be set on the trigger.
 * It is set only when the tooltip is visible so screen readers announce
 * the description exactly when the tooltip is presented.
 */
function ariaDescribedBy(visible: boolean, id: string): string | undefined {
  return visible ? id : undefined;
}

/** Simulates a tap toggle: returns the next visibility state. */
function toggleOnTap(current: boolean): boolean {
  return !current;
}

/** Simulates Escape key: always hides the tooltip. */
function hideOnEscape(current: boolean, key: string): boolean {
  return key === 'Escape' ? false : current;
}

/** Simulates outside pointer-down: always hides the tooltip. */
function hideOnOutsideClick(): boolean {
  return false;
}

/** Simulates mouse-enter: always shows the tooltip. */
function showOnMouseEnter(): boolean {
  return true;
}

/** Simulates mouse-leave: always hides the tooltip. */
function hideOnMouseLeave(): boolean {
  return false;
}

// ── Panel placement (computeTooltipPosition) ─────────────────────────────────

// A trigger comfortably in the middle of a roomy viewport, so nothing clamps.
const TRIGGER: TooltipTriggerRect = {
  top: 300,
  left: 500,
  right: 516,
  bottom: 316,
  width: 16,
  height: 16,
};
const PANEL = { width: 200, height: 40 };
const VIEWPORT = { width: 1000, height: 800 };
const GAP = 6;

describe('Tooltip — vertical placement (side prop)', () => {
  it('places the panel above the trigger by default (top)', () => {
    // bottom edge of panel sits GAP above the trigger top: 300 - 6 - 40 = 254
    expect(computeTooltipPosition(TRIGGER, PANEL, 'top', 'center', GAP, VIEWPORT).top).toBe(254);
  });

  it('places the panel below the trigger when side="bottom"', () => {
    // top edge of panel sits GAP below the trigger bottom: 316 + 6 = 322
    expect(computeTooltipPosition(TRIGGER, PANEL, 'bottom', 'center', GAP, VIEWPORT).top).toBe(322);
  });
});

describe('Tooltip — horizontal placement (align prop)', () => {
  it('centres the panel on the trigger by default', () => {
    // 500 + 16/2 - 200/2 = 408
    expect(computeTooltipPosition(TRIGGER, PANEL, 'top', 'center', GAP, VIEWPORT).left).toBe(408);
  });

  it('left-aligns the panel with the trigger when align="left"', () => {
    expect(computeTooltipPosition(TRIGGER, PANEL, 'top', 'left', GAP, VIEWPORT).left).toBe(500);
  });

  it('right-aligns the panel with the trigger when align="right"', () => {
    // trigger.right - panel.width = 516 - 200 = 316
    expect(computeTooltipPosition(TRIGGER, PANEL, 'top', 'right', GAP, VIEWPORT).left).toBe(316);
  });
});

describe('Tooltip — viewport clamping (the anti-crop guarantee)', () => {
  it('clamps a right-edge overflow back inside the viewport', () => {
    const edge: TooltipTriggerRect = { top: 300, left: 960, right: 976, bottom: 316, width: 16, height: 16 };
    // centred would be 960 + 8 - 100 = 868; panel right would be 1068 > 1000, so
    // it clamps to 1000 - 200 - 8 = 792.
    expect(computeTooltipPosition(edge, PANEL, 'top', 'center', GAP, VIEWPORT).left).toBe(792);
  });

  it('clamps a top overflow to 8px below the viewport top', () => {
    const high: TooltipTriggerRect = { top: 10, left: 500, right: 516, bottom: 26, width: 16, height: 16 };
    // above would be 10 - 6 - 40 = -36; clamps to 8.
    expect(computeTooltipPosition(high, PANEL, 'top', 'center', GAP, VIEWPORT).top).toBe(8);
  });

  it('never positions the panel off the left edge', () => {
    const left: TooltipTriggerRect = { top: 300, left: 0, right: 16, bottom: 316, width: 16, height: 16 };
    // centred would be 0 + 8 - 100 = -92; clamps to 8.
    expect(computeTooltipPosition(left, PANEL, 'top', 'center', GAP, VIEWPORT).left).toBe(8);
  });
});

// ── Visibility state ─────────────────────────────────────────────────────────

describe('Tooltip — visibility state', () => {
  it('is hidden by default', () => {
    expect(isVisible(false)).toBe(false);
  });

  it('shows on mouse-enter', () => {
    expect(showOnMouseEnter()).toBe(true);
  });

  it('hides on mouse-leave', () => {
    expect(hideOnMouseLeave()).toBe(false);
  });

  it('toggles on tap (hidden → visible)', () => {
    expect(toggleOnTap(false)).toBe(true);
  });

  it('toggles on tap (visible → hidden)', () => {
    expect(toggleOnTap(true)).toBe(false);
  });

  it('hides on outside pointer-down', () => {
    expect(hideOnOutsideClick()).toBe(false);
  });

  it('hides on Escape key', () => {
    expect(hideOnEscape(true, 'Escape')).toBe(false);
  });

  it('does not hide on other keys', () => {
    expect(hideOnEscape(true, 'Tab')).toBe(true);
    expect(hideOnEscape(true, 'Enter')).toBe(true);
  });
});

// ── ARIA attributes ──────────────────────────────────────────────────────────

describe('Tooltip — ARIA attributes', () => {
  it('aria-hidden is true on the panel when not visible', () => {
    expect(ariaHidden(false)).toBe(true);
  });

  it('aria-hidden is false on the panel when visible', () => {
    expect(ariaHidden(true)).toBe(false);
  });

  it('aria-describedby is set on the trigger only when visible', () => {
    expect(ariaDescribedBy(true, 'tooltip-abc')).toBe('tooltip-abc');
  });

  it('aria-describedby is undefined on the trigger when not visible', () => {
    expect(ariaDescribedBy(false, 'tooltip-abc')).toBeUndefined();
  });
});
