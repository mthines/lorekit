/**
 * BottomSheet — pure drag-dismiss tests (node environment, no DOM/React).
 *
 * Covers `shouldDismissSheet`, the single decision behind drag-to-close. The
 * rendered behaviour (backdrop click, Escape, focus, the actual pointer drag)
 * is covered by the interaction stories in `BottomSheet.test.stories.tsx`.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_DISMISS_THRESHOLDS,
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
