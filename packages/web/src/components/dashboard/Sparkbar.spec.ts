import { describe, expect, it } from 'vitest';

import { nextIndex } from './Sparkbar';

/**
 * The chart is ONE tab stop that walks its buckets with the arrow keys, so this
 * function is the whole keyboard model. The properties that matter are the entry
 * point (which bucket you land on with nothing selected) and the clamping — a bar
 * chart is a line, not a ring, so wrapping from the newest bucket to the oldest
 * would read as a glitch.
 */
describe('nextIndex', () => {
  const COUNT = 5;

  it('enters at the LAST bucket, whichever horizontal arrow starts it', () => {
    // The most recent bucket is the one the chart already emphasises, so it is
    // the one a keyboard reader is most likely to have come for.
    expect(nextIndex(null, 'ArrowRight', COUNT)).toBe(COUNT - 1);
    expect(nextIndex(null, 'ArrowLeft', COUNT)).toBe(COUNT - 1);
  });

  it('steps forward and back', () => {
    expect(nextIndex(2, 'ArrowRight', COUNT)).toBe(3);
    expect(nextIndex(2, 'ArrowLeft', COUNT)).toBe(1);
  });

  it('clamps at both ends rather than wrapping', () => {
    expect(nextIndex(COUNT - 1, 'ArrowRight', COUNT)).toBe(COUNT - 1);
    expect(nextIndex(0, 'ArrowLeft', COUNT)).toBe(0);
  });

  it('jumps to the ends with Home and End, from anywhere', () => {
    expect(nextIndex(3, 'Home', COUNT)).toBe(0);
    expect(nextIndex(3, 'End', COUNT)).toBe(COUNT - 1);
    expect(nextIndex(null, 'Home', COUNT)).toBe(0);
    expect(nextIndex(null, 'End', COUNT)).toBe(COUNT - 1);
  });

  it('returns null for a key it does not handle, so the caller can let it through', () => {
    // Load-bearing: the component only calls `preventDefault()` when this
    // returns a target, so Tab, Enter and typing keep working normally.
    for (const key of ['Tab', 'Enter', ' ', 'a', 'ArrowUp', 'ArrowDown', 'Escape']) {
      expect(nextIndex(2, key, COUNT)).toBeNull();
    }
  });

  it('is total for a single-bucket chart', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(nextIndex(null, key, 1)).toBe(0);
      expect(nextIndex(0, key, 1)).toBe(0);
    }
  });
});
