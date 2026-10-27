import { describe, expect, it } from 'vitest';

import {
  PANEL_DEFAULT_WIDTH_PX,
  PANEL_KEYBOARD_LARGE_STEP_PX,
  PANEL_KEYBOARD_STEP_PX,
  PANEL_MIN_WIDTH_PX,
  clampPanelWidth,
  keyboardPanelWidth,
  panelFractionFromWidth,
  panelWidthBounds,
  panelWidthCss,
  panelWidthPx,
  viewportPercent,
} from './lesson-panel-width';

/**
 * The panel's width is drawn by a CSS `clamp()` and reported/stored by these
 * functions, so the two must agree at every screen size the drawer appears at
 * (768px and up). The viewports below are the common laptop and monitor widths.
 */
const LAPTOP = 1440;
const DESKTOP = 1920;
const QHD = 2560;
const ULTRAWIDE = 3440;

describe('panelWidthBounds', () => {
  it('keeps an absolute floor on small screens', () => {
    expect(panelWidthBounds(768).min).toBe(PANEL_MIN_WIDTH_PX);
    expect(panelWidthBounds(LAPTOP).min).toBe(PANEL_MIN_WIDTH_PX);
  });

  it('raises the floor with the screen once 15% of it passes the absolute floor', () => {
    expect(panelWidthBounds(QHD).min).toBeCloseTo(384);
    expect(panelWidthBounds(ULTRAWIDE).min).toBeCloseTo(516);
  });

  it('caps the panel at 70% of the screen', () => {
    expect(panelWidthBounds(768).max).toBeCloseTo(537.6);
    expect(panelWidthBounds(LAPTOP).max).toBeCloseTo(1008);
    expect(panelWidthBounds(ULTRAWIDE).max).toBeCloseTo(2408);
  });

  it('never lets the ceiling fall below the floor (CSS clamp lets the minimum win)', () => {
    const { min, max } = panelWidthBounds(400);
    expect(min).toBe(PANEL_MIN_WIDTH_PX);
    expect(max).toBe(min);
  });
});

describe('panelWidthPx', () => {
  it('renders the historical 512px default when nothing is stored', () => {
    for (const viewport of [768, LAPTOP, DESKTOP, QHD]) {
      expect(panelWidthPx(null, viewport)).toBe(PANEL_DEFAULT_WIDTH_PX);
    }
  });

  it('lifts the default to the floor on a screen wide enough for the floor to pass it', () => {
    expect(panelWidthPx(null, ULTRAWIDE)).toBeCloseTo(516);
  });

  it('scales a stored fraction with the screen — the point of storing a fraction', () => {
    // Widened to 900px on a 2560px monitor…
    const fraction = panelFractionFromWidth(900, QHD);
    // …is the same share of a laptop screen, and the same 900px back on the monitor.
    expect(panelWidthPx(fraction, LAPTOP)).toBeCloseTo(506, 0);
    expect(panelWidthPx(fraction, QHD)).toBeCloseTo(900, 0);
  });

  it('holds a stored fraction inside the bounds of the current screen', () => {
    // 10% is under the floor everywhere; 95% is over the ceiling everywhere.
    expect(panelWidthPx(0.1, LAPTOP)).toBe(PANEL_MIN_WIDTH_PX);
    expect(panelWidthPx(0.95, LAPTOP)).toBeCloseTo(1008);
  });
});

describe('panelFractionFromWidth', () => {
  it('stores the dragged width as a share of the screen, rounded to four places', () => {
    expect(panelFractionFromWidth(720, LAPTOP)).toBe(0.5);
    expect(panelFractionFromWidth(544, 1200)).toBe(0.4533);
  });

  it('stores the bound, not the overshoot, when a drag goes past either edge', () => {
    expect(panelFractionFromWidth(100, LAPTOP)).toBe(Math.round((320 / LAPTOP) * 10_000) / 10_000);
    expect(panelFractionFromWidth(5000, LAPTOP)).toBe(0.7);
  });

  it('returns 0 — which never parses back as a width — for an unmeasurable viewport', () => {
    expect(panelFractionFromWidth(500, 0)).toBe(0);
  });
});

describe('panelWidthCss', () => {
  it('draws the default as 512px inside viewport-relative bounds', () => {
    expect(panelWidthCss(null)).toBe('clamp(max(320px, 15vw), 512px, 70vw)');
  });

  it('draws a stored fraction in vw so a resize re-resolves it without JavaScript', () => {
    expect(panelWidthCss(0.4533)).toBe('clamp(max(320px, 15vw), 45.33vw, 70vw)');
  });
});

describe('clampPanelWidth', () => {
  it('passes a width inside the bounds through unchanged', () => {
    expect(clampPanelWidth(600, LAPTOP)).toBe(600);
  });
});

describe('keyboardPanelWidth', () => {
  it('widens on ArrowLeft and narrows on ArrowRight (the panel sits on the right)', () => {
    expect(keyboardPanelWidth('ArrowLeft', { shiftKey: false }, 512, LAPTOP)).toBe(
      512 + PANEL_KEYBOARD_STEP_PX,
    );
    expect(keyboardPanelWidth('ArrowRight', { shiftKey: false }, 512, LAPTOP)).toBe(
      512 - PANEL_KEYBOARD_STEP_PX,
    );
  });

  it('takes a larger step with Shift', () => {
    expect(keyboardPanelWidth('ArrowLeft', { shiftKey: true }, 512, LAPTOP)).toBe(
      512 + PANEL_KEYBOARD_LARGE_STEP_PX,
    );
  });

  it('stops at the bounds', () => {
    expect(keyboardPanelWidth('ArrowRight', { shiftKey: true }, 330, LAPTOP)).toBe(PANEL_MIN_WIDTH_PX);
    expect(keyboardPanelWidth('ArrowLeft', { shiftKey: true }, 1000, LAPTOP)).toBeCloseTo(1008);
  });

  it('jumps to the smallest size on Home and the largest on End', () => {
    expect(keyboardPanelWidth('Home', { shiftKey: false }, 700, LAPTOP)).toBe(PANEL_MIN_WIDTH_PX);
    expect(keyboardPanelWidth('End', { shiftKey: false }, 700, LAPTOP)).toBeCloseTo(1008);
  });

  it('ignores every other key', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape', 'a']) {
      expect(keyboardPanelWidth(key, { shiftKey: false }, 512, LAPTOP)).toBeNull();
    }
  });
});

describe('viewportPercent', () => {
  it('reports a whole percentage of the screen', () => {
    expect(viewportPercent(512, 1200)).toBe(43);
    expect(viewportPercent(720, LAPTOP)).toBe(50);
  });

  it('reports 0 rather than dividing by zero', () => {
    expect(viewportPercent(512, 0)).toBe(0);
  });
});
