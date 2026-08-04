import { describe, expect, it } from 'vitest';

import { shouldAnimate } from './ambient-animation';

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
