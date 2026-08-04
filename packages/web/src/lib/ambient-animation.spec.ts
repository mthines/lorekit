/**
 * Tests for the pure rules behind `lib/hooks/useAmbientAnimation.ts`.
 *
 * `shouldAnimate` is the final predicate; the four functions below it are the
 * decisions the hook used to make inline — fail open, whether the node is
 * observable yet, which `IntersectionObserver` entry to believe, and what
 * counts as the foreground tab.
 *
 * What is NOT covered here: the hook's wiring — that `observe` is called with
 * the node the callback ref delivered, that `disconnect` runs on unmount, that
 * the `visibilitychange` listener is added and removed. Asserting those needs
 * jsdom + `@testing-library/react`, neither of which is a dependency of this
 * package (same gap `useUrlState.spec.ts` and `FormActionBar.spec.ts` record).
 * Add those integration tests alongside the harness, not by weakening these.
 */

import { describe, expect, it } from 'vitest';

import {
  ON_SCREEN_WHEN_UNOBSERVABLE,
  canObserve,
  isPageVisible,
  onScreenFrom,
  shouldAnimate,
} from './ambient-animation';

describe('shouldAnimate', () => {
  it('runs when the element is on screen in the foreground tab', () => {
    expect(shouldAnimate({ onScreen: true, pageVisible: true })).toBe(true);
  });

  it('pauses when the element is scrolled out of view', () => {
    expect(shouldAnimate({ onScreen: false, pageVisible: true })).toBe(false);
  });

  it('pauses when the tab is in the background', () => {
    expect(shouldAnimate({ onScreen: true, pageVisible: false })).toBe(false);
  });

  it('pauses when both conditions fail', () => {
    expect(shouldAnimate({ onScreen: false, pageVisible: false })).toBe(false);
  });
});

describe('canObserve', () => {
  it('observes once the callback ref has delivered a node and the API exists', () => {
    expect(canObserve({}, true)).toBe(true);
  });

  it('does not observe on the first pass, before the callback ref fires', () => {
    expect(canObserve(null, true)).toBe(false);
  });

  it('does not observe when the browser has no IntersectionObserver', () => {
    expect(canObserve({}, false)).toBe(false);
  });

  it('does not observe when neither the node nor the API is available', () => {
    expect(canObserve(null, false)).toBe(false);
  });
});

describe('onScreenFrom', () => {
  it('adopts the first entry when the element enters the viewport', () => {
    expect(onScreenFrom([{ isIntersecting: true }], false)).toBe(true);
  });

  it('adopts the first entry when the element leaves the viewport', () => {
    expect(onScreenFrom([{ isIntersecting: false }], true)).toBe(false);
  });

  it('reads only the first entry — the observer watches one element', () => {
    expect(onScreenFrom([{ isIntersecting: false }, { isIntersecting: true }], true)).toBe(false);
  });

  it('holds the current value on an empty batch rather than pausing', () => {
    expect(onScreenFrom([], true)).toBe(true);
  });

  it('holds the current value on an empty batch rather than resuming', () => {
    expect(onScreenFrom([], false)).toBe(false);
  });
});

describe('isPageVisible', () => {
  it('is the foreground tab only for the "visible" state', () => {
    expect(isPageVisible('visible')).toBe(true);
  });

  it('is not the foreground tab when hidden', () => {
    expect(isPageVisible('hidden')).toBe(false);
  });

  it('is not the foreground tab while prerendering', () => {
    expect(isPageVisible('prerender')).toBe(false);
  });

  it('is not the foreground tab when there is no document (SSR)', () => {
    expect(isPageVisible(undefined)).toBe(false);
  });
});

describe('fail-open behaviour', () => {
  // The hook seeds `onScreen` with ON_SCREEN_WHEN_UNOBSERVABLE and only ever
  // replaces it from an observer callback, so a browser without
  // IntersectionObserver keeps that seed for the lifetime of the component.
  const onScreenWithout = (hasObserver: boolean, node: object | null) =>
    canObserve(node, hasObserver)
      ? onScreenFrom([], ON_SCREEN_WHEN_UNOBSERVABLE)
      : ON_SCREEN_WHEN_UNOBSERVABLE;

  it('keeps animating when the browser has no IntersectionObserver', () => {
    const onScreen = onScreenWithout(false, {});
    expect(shouldAnimate({ onScreen, pageVisible: isPageVisible('visible') })).toBe(true);
  });

  it('keeps animating on the first render, before the node is observed', () => {
    const onScreen = onScreenWithout(true, null);
    expect(shouldAnimate({ onScreen, pageVisible: isPageVisible('visible') })).toBe(true);
  });

  it('still pauses in a background tab even when it cannot observe', () => {
    const onScreen = onScreenWithout(false, {});
    expect(shouldAnimate({ onScreen, pageVisible: isPageVisible('hidden') })).toBe(false);
  });
});
