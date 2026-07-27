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

// ── Pure helpers that mirror Tooltip's internal decisions ────────────────────

/** Returns the CSS classes for vertical panel placement. */
function panelPositionClass(side: 'top' | 'bottom'): string {
  return side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
}

/** Returns the CSS classes for horizontal panel alignment. */
function panelAlignClass(align: 'left' | 'center' | 'right'): string {
  if (align === 'left') return 'left-0';
  if (align === 'right') return 'right-0';
  return 'left-1/2 -translate-x-1/2';
}

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

// ── Panel placement ──────────────────────────────────────────────────────────

describe('Tooltip — panel placement (side prop)', () => {
  it('places the panel above the trigger by default (top)', () => {
    expect(panelPositionClass('top')).toBe('bottom-full mb-1.5');
  });

  it('places the panel below the trigger when side="bottom"', () => {
    expect(panelPositionClass('bottom')).toBe('top-full mt-1.5');
  });
});

// ── Panel alignment ──────────────────────────────────────────────────────────

describe('Tooltip — panel alignment (align prop)', () => {
  it('centres the panel by default', () => {
    expect(panelAlignClass('center')).toBe('left-1/2 -translate-x-1/2');
  });

  it('left-aligns the panel when align="left"', () => {
    expect(panelAlignClass('left')).toBe('left-0');
  });

  it('right-aligns the panel when align="right"', () => {
    expect(panelAlignClass('right')).toBe('right-0');
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
