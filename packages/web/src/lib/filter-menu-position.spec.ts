/**
 * Contract tests for the filter popover's placement.
 *
 * The popover became `fixed` (portaled out of the Explorer's `overflow-hidden`
 * ancestors, which were clipping it), which means nothing in the DOM bounds it
 * any more — every edge case an overflow ancestor used to hide is now this
 * function's responsibility. These pin the three that matter: the horizontal
 * clamp, when the menu flips above its trigger, and the list cap.
 */

import { describe, it, expect } from 'vitest';
import {
  CHROME_HEIGHT,
  GAP,
  MAX_LIST_HEIGHT,
  MIN_LIST_HEIGHT,
  POPOVER_WIDTH,
  VIEWPORT_MARGIN,
  anchoredPosition,
} from './filter-menu-position';

const VIEWPORT = { width: 1280, height: 800 };

/** A trigger 36px tall (the row's `min-h-9`) at a given position. */
function trigger(left: number, top: number) {
  return { left, top, bottom: top + 36 };
}

describe('anchoredPosition — vertical placement', () => {
  it('hangs below the trigger when there is room', () => {
    const p = anchoredPosition(trigger(100, 120), VIEWPORT);
    expect(p.top).toBe(156 + GAP);
    expect(p.bottom).toBeUndefined();
  });

  it('flips above when below cannot hold a usable list and above can hold more', () => {
    // 40px of room below, ~700 above.
    const p = anchoredPosition(trigger(100, 724), VIEWPORT);
    expect(p.top).toBeUndefined();
    expect(p.bottom, 'anchored to the trigger’s top edge').toBe(VIEWPORT.height - 724 + GAP);
  });

  it('stays below on a near-tie — a menu that flips on a few pixels feels unstable', () => {
    // Below is cramped, but above is cramped by the same amount: prefer the
    // direction the trigger implies rather than moving for no gain.
    const height = 2 * (MIN_LIST_HEIGHT + CHROME_HEIGHT);
    const p = anchoredPosition({ left: 100, top: height / 2 - 18, bottom: height / 2 + 18 }, {
      width: 1280,
      height,
    });
    expect(p.top, 'ties go to below').toBeDefined();
  });

  it('stays below when neither side has room — below is the implied direction', () => {
    const p = anchoredPosition({ left: 100, top: 10, bottom: 46 }, { width: 1280, height: 90 });
    expect(p.top).toBe(52);
    expect(p.listMaxHeight, 'still never below the floor').toBe(MIN_LIST_HEIGHT);
  });
});

describe('anchoredPosition — horizontal clamp', () => {
  it('left-aligns with the trigger when the menu fits', () => {
    expect(anchoredPosition(trigger(100, 120), VIEWPORT).left).toBe(100);
  });

  it('pulls the menu back on-screen at the right edge', () => {
    const p = anchoredPosition(trigger(1240, 120), VIEWPORT);
    expect(p.left).toBe(VIEWPORT.width - POPOVER_WIDTH - VIEWPORT_MARGIN);
    expect(p.left + POPOVER_WIDTH, 'the right edge stays inside the viewport').toBeLessThanOrEqual(
      VIEWPORT.width - VIEWPORT_MARGIN,
    );
  });

  it('never goes off the left edge, even on a viewport narrower than the menu', () => {
    expect(anchoredPosition(trigger(4, 120), VIEWPORT).left).toBe(VIEWPORT_MARGIN);
    expect(anchoredPosition(trigger(0, 120), { width: 240, height: 800 }).left).toBe(
      VIEWPORT_MARGIN,
    );
  });
});

describe('anchoredPosition — list height', () => {
  it('caps at the resting maximum when space is plentiful', () => {
    expect(anchoredPosition(trigger(100, 60), VIEWPORT).listMaxHeight).toBe(MAX_LIST_HEIGHT);
  });

  it('shrinks the list to the space that actually exists', () => {
    // ~300px below the trigger: chrome comes off the top, and the rest is list.
    const p = anchoredPosition(trigger(100, 460), VIEWPORT);
    expect(p.listMaxHeight).toBeLessThan(MAX_LIST_HEIGHT);
    expect(p.listMaxHeight).toBeGreaterThanOrEqual(MIN_LIST_HEIGHT);
  });

  it('measures the side it actually chose — a flipped menu gets the room above', () => {
    // A trigger near the bottom flips, so the list is bounded by the ~770px
    // ABOVE it, not by the 14px below. Measuring the unchosen side would
    // collapse a menu that has the whole page to grow into.
    const p = anchoredPosition(trigger(100, 780), { width: 1280, height: 800 });
    expect(p.bottom, 'this trigger flips').toBeDefined();
    expect(p.listMaxHeight).toBe(MAX_LIST_HEIGHT);
  });

  it('never returns a list shorter than the floor, however cramped', () => {
    // Nowhere to flip TO: both sides are smaller than the floor.
    const p = anchoredPosition({ left: 100, top: 60, bottom: 96 }, { width: 1280, height: 160 });
    expect(p.listMaxHeight).toBe(MIN_LIST_HEIGHT);
  });

  it('always returns exactly one of top / bottom', () => {
    for (const top of [0, 120, 400, 700, 780]) {
      const p = anchoredPosition(trigger(100, top), VIEWPORT);
      expect(
        (p.top === undefined) !== (p.bottom === undefined),
        `top=${p.top} bottom=${p.bottom} for trigger at ${top}`,
      ).toBe(true);
    }
  });
});
