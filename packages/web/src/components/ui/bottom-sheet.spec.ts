/**
 * BottomSheet — pure drag tests (node environment, no DOM/React).
 *
 * Covers `shouldDismissSheet` (does a release close the sheet) and
 * `classifyBodyDrag` (is a body gesture a drag or a content scroll). The
 * rendered behaviour (backdrop click, Escape, focus, the actual pointer drag)
 * is covered by the interaction stories in `BottomSheet.test.stories.tsx`.
 */

import { describe, it, expect } from 'vitest';

import {
  BODY_DRAG_SLOP,
  DEFAULT_DISMISS_THRESHOLDS,
  classifyBodyDrag,
  shouldDismissSheet,
  type SheetDismissThresholds,
} from './bottom-sheet';

const { distance, velocity } = DEFAULT_DISMISS_THRESHOLDS;

describe('shouldDismissSheet', () => {
  it('does not dismiss when the sheet is dragged up', () => {
    expect(shouldDismissSheet({ offsetY: -200, velocityY: -900 })).toBe(false);
  });

  it('does not dismiss on a resting release with no movement', () => {
    expect(shouldDismissSheet({ offsetY: 0, velocityY: 0 })).toBe(false);
  });

  it('does not dismiss on a small, slow downward pull (snaps back)', () => {
    expect(shouldDismissSheet({ offsetY: distance - 1, velocityY: velocity - 1 })).toBe(false);
  });

  it('dismisses once pulled past the distance threshold, even when slow', () => {
    expect(shouldDismissSheet({ offsetY: distance, velocityY: 0 })).toBe(true);
  });

  it('dismisses on a fast downward flick, even when short', () => {
    expect(shouldDismissSheet({ offsetY: 12, velocityY: velocity })).toBe(true);
  });

  it('requires downward motion for the velocity path (an up-flick never closes)', () => {
    expect(shouldDismissSheet({ offsetY: -1, velocityY: 5000 })).toBe(false);
  });

  it('honours custom thresholds', () => {
    const strict: SheetDismissThresholds = { distance: 300, velocity: 2000 };
    expect(shouldDismissSheet({ offsetY: 120, velocityY: 500 }, strict)).toBe(false);
    expect(shouldDismissSheet({ offsetY: 320, velocityY: 0 }, strict)).toBe(true);
    expect(shouldDismissSheet({ offsetY: 10, velocityY: 2500 }, strict)).toBe(true);
  });
});

describe('classifyBodyDrag', () => {
  const past = BODY_DRAG_SLOP + 4;

  it('stays pending until the gesture clears the slop', () => {
    expect(
      classifyBodyDrag({ scrollTop: 0, scrollable: false, dy: BODY_DRAG_SLOP - 1 }),
    ).toBe('pending');
    expect(
      classifyBodyDrag({ scrollTop: 0, scrollable: false, dy: -(BODY_DRAG_SLOP - 1) }),
    ).toBe('pending');
  });

  it('drags in either direction when the content does not scroll', () => {
    expect(classifyBodyDrag({ scrollTop: 0, scrollable: false, dy: past })).toBe('drag');
    expect(classifyBodyDrag({ scrollTop: 0, scrollable: false, dy: -past })).toBe('drag');
  });

  it('drags on a downward pull from the top of a scroll area', () => {
    expect(classifyBodyDrag({ scrollTop: 0, scrollable: true, dy: past })).toBe('drag');
  });

  it('scrolls on an upward pull from the top of a scroll area', () => {
    expect(classifyBodyDrag({ scrollTop: 0, scrollable: true, dy: -past })).toBe('scroll');
  });

  it('yields the whole gesture to a scroll area that is already scrolled', () => {
    // Even a large downward pull scrolls — the sheet never moves until the
    // content is back at its top.
    expect(classifyBodyDrag({ scrollTop: 40, scrollable: true, dy: past })).toBe('scroll');
    expect(classifyBodyDrag({ scrollTop: 40, scrollable: true, dy: -past })).toBe('scroll');
  });

  it('honours a custom slop', () => {
    expect(classifyBodyDrag({ scrollTop: 0, scrollable: false, dy: 20, slop: 40 })).toBe(
      'pending',
    );
    expect(classifyBodyDrag({ scrollTop: 0, scrollable: false, dy: 60, slop: 40 })).toBe('drag');
  });
});
