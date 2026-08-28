import { describe, expect, it } from 'vitest';
import { registerClick } from './click-gesture';

const WINDOW_MS = 2000;
const THRESHOLD = 5;

describe('registerClick', () => {
  it('starts a run of 1 on the first click', () => {
    const result = registerClick(null, 0, 1000, WINDOW_MS, THRESHOLD);
    expect(result).toEqual({ runLength: 1, triggered: false });
  });

  it('extends the run when the next click lands within the window', () => {
    const result = registerClick(1000, 1, 1500, WINDOW_MS, THRESHOLD);
    expect(result).toEqual({ runLength: 2, triggered: false });
  });

  it('resets the run to 1 when the next click lands outside the window', () => {
    const result = registerClick(1000, 3, 1000 + WINDOW_MS + 1, WINDOW_MS, THRESHOLD);
    expect(result).toEqual({ runLength: 1, triggered: false });
  });

  it('counts a click landing exactly at the window boundary as still in the run', () => {
    const result = registerClick(1000, 1, 1000 + WINDOW_MS, WINDOW_MS, THRESHOLD);
    expect(result.runLength).toBe(2);
  });

  it('triggers exactly when the run reaches the threshold, not before', () => {
    let lastClickAt: number | null = null;
    let runLength = 0;
    let now = 0;
    for (let i = 1; i < THRESHOLD; i++) {
      now += 100;
      const result = registerClick(lastClickAt, runLength, now, WINDOW_MS, THRESHOLD);
      expect(result.triggered).toBe(false);
      lastClickAt = now;
      runLength = result.runLength;
    }
    now += 100;
    const final = registerClick(lastClickAt, runLength, now, WINDOW_MS, THRESHOLD);
    expect(final).toEqual({ runLength: THRESHOLD, triggered: true });
  });

  it('a slow click, well outside the window, never chains into a trigger', () => {
    // Four clicks in rhythm, then one far too late — the run resets instead
    // of completing on what would otherwise be the 5th click.
    let lastClickAt: number | null = null;
    let runLength = 0;
    const gaps: number[] = [0, 100, 100, 100];
    for (const gap of gaps) {
      const clickAt: number = (lastClickAt ?? 0) + gap;
      const result = registerClick(lastClickAt, runLength, clickAt, WINDOW_MS, THRESHOLD);
      lastClickAt = clickAt;
      runLength = result.runLength;
    }
    expect(runLength).toBe(4);

    const tooLate = (lastClickAt ?? 0) + WINDOW_MS + 1;
    const result = registerClick(lastClickAt, runLength, tooLate, WINDOW_MS, THRESHOLD);
    expect(result).toEqual({ runLength: 1, triggered: false });
  });
});
