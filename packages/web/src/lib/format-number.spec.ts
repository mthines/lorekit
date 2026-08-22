import { describe, expect, it } from 'vitest';

import {
  formatCompact,
  formatExact,
  formatPercentDelta,
  isPercentDeltaAbbreviated,
} from './format-number';

describe('formatExact', () => {
  it('groups thousands', () => {
    expect(formatExact(1247)).toBe('1,247');
    expect(formatExact(1_234_567)).toBe('1,234,567');
  });

  it('leaves small figures alone', () => {
    expect(formatExact(0)).toBe('0');
    expect(formatExact(999)).toBe('999');
  });

  /**
   * The SSR/hydration guard. A bare `toLocaleString()` would render `1.247`
   * under a de-DE runtime and `1,247` under en-US, so the server's HTML and the
   * browser's first render could disagree.
   */
  it('is pinned to en-US, not to the runtime locale', () => {
    const original = process.env['LANG'];
    try {
      process.env['LANG'] = 'de_DE.UTF-8';
      expect(formatExact(1247)).toBe('1,247');
    } finally {
      if (original === undefined) delete process.env['LANG'];
      else process.env['LANG'] = original;
    }
  });
});

describe('formatCompact', () => {
  it('renders small figures as plain digits, ungrouped', () => {
    // Ungrouped on purpose: the separator is the character that pushes a
    // four-digit figure past its ~58px column on a phone.
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(12)).toBe('12');
    expect(formatCompact(9999)).toBe('9999');
  });

  it('switches to compact notation at the threshold', () => {
    expect(formatCompact(10_000)).toBe('10K');
    expect(formatCompact(12_345)).toBe('12.3K');
    expect(formatCompact(1_234_567)).toBe('1.2M');
  });

  /**
   * The property the threshold exists for: whatever the magnitude, the result
   * has to fit a quarter of a phone's width. Five characters at `text-xl`
   * tabular-nums is ~60px, which is the column.
   */
  it('never exceeds five characters at any magnitude', () => {
    const magnitudes = [0, 9, 99, 999, 9999, 10_000, 99_999, 999_999, 9_999_999, 1_000_000_000];
    for (const n of magnitudes) {
      expect(formatCompact(n).length).toBeLessThanOrEqual(5);
    }
  });

  it('agrees with formatExact below the threshold, separators aside', () => {
    for (const n of [0, 7, 42, 999, 9999]) {
      expect(formatCompact(n)).toBe(formatExact(n).replace(/,/g, ''));
    }
  });
});

/**
 * The trend chip shares a line with the headline figure it annotates and carries
 * two characters the figure does not (a sign and a `%`), so it abbreviates an
 * order of magnitude earlier than a headline does. `+8834%` was colliding with a
 * `22,425` on a desktop and clipped at the card edge on a phone.
 */
describe('formatPercentDelta', () => {
  it('leaves small deltas EXACTLY as they were', () => {
    // The regression this protects: `+100%` means "doubled" and is read as a
    // quantity. Abbreviating it (to `+0.1k%`) would destroy the one figure in
    // this range anybody actually reasons about.
    expect(formatPercentDelta(0)).toBe('0%');
    expect(formatPercentDelta(7)).toBe('+7%');
    expect(formatPercentDelta(100)).toBe('+100%');
    expect(formatPercentDelta(999)).toBe('+999%');
    expect(formatPercentDelta(-42)).toBe('-42%');
    expect(formatPercentDelta(-999)).toBe('-999%');
  });

  it('abbreviates from four digits up — the magnitude that stopped fitting', () => {
    expect(formatPercentDelta(1000)).toBe('+1K%');
    expect(formatPercentDelta(8834)).toBe('+8.8K%');
    expect(formatPercentDelta(2_000_000)).toBe('+2M%');
  });

  it('never shows a trailing .0', () => {
    // `2000` is `2K`, not `2.0K` — the fraction digit is dropped when it is zero.
    expect(formatPercentDelta(2000)).toBe('+2K%');
    expect(formatPercentDelta(10_000)).toBe('+10K%');
    expect(formatPercentDelta(1_000_000)).toBe('+1M%');
  });

  it('rounds across the magnitude rather than showing a second decimal', () => {
    // 9.95K would need two fraction digits to be exact, so it rounds to 10K —
    // not `9.9K` (wrong) and not `10.0K` (a trailing zero).
    expect(formatPercentDelta(9950)).toBe('+10K%');
    expect(formatPercentDelta(9949)).toBe('+9.9K%');
    // Two significant digits, so the hundreds band drops its fraction entirely
    // rather than growing to six characters (`883.4K`).
    expect(formatPercentDelta(883_400)).toBe('+880K%');
  });

  it('treats negatives identically, keeping the minus', () => {
    expect(formatPercentDelta(-8834)).toBe('-8.8K%');
    expect(formatPercentDelta(-2000)).toBe('-2K%');
    expect(formatPercentDelta(-9950)).toBe('-10K%');
  });

  it('is symmetric about zero, sign aside', () => {
    for (const n of [7, 100, 999, 1000, 8834, 9950, 2_000_000]) {
      expect(formatPercentDelta(-n)).toBe(`-${formatPercentDelta(n).slice(1)}`);
    }
  });

  /**
   * The property the change exists for. Six characters at `text-xs`
   * tabular-nums is the gap the chip has beside a five-digit headline; the old
   * `+8834%` was seven and `+883400%` would have been nine.
   */
  it('stays within six characters at any magnitude', () => {
    const magnitudes = [0, 9, 99, 999, 1000, 8834, 99_999, 883_400, 9_999_999, 1e9, 1e12];
    for (const n of magnitudes) {
      expect(formatPercentDelta(n).length).toBeLessThanOrEqual(6);
      expect(formatPercentDelta(-n).length).toBeLessThanOrEqual(6);
    }
  });

  it('is pinned to en-US like the other two, for the same hydration reason', () => {
    const original = process.env['LANG'];
    try {
      process.env['LANG'] = 'de_DE.UTF-8';
      expect(formatPercentDelta(8834)).toBe('+8.8K%');
    } finally {
      if (original === undefined) delete process.env['LANG'];
      else process.env['LANG'] = original;
    }
  });
});

describe('isPercentDeltaAbbreviated', () => {
  it('is true exactly when precision was dropped', () => {
    // Drives whether a caller bothers to expose the exact figure, so it has to
    // agree with `formatPercentDelta` at the boundary rather than near it.
    expect(isPercentDeltaAbbreviated(999)).toBe(false);
    expect(isPercentDeltaAbbreviated(1000)).toBe(true);
    expect(isPercentDeltaAbbreviated(-999)).toBe(false);
    expect(isPercentDeltaAbbreviated(-1000)).toBe(true);
    expect(isPercentDeltaAbbreviated(0)).toBe(false);
  });

  it('agrees with the formatter: unabbreviated output contains the exact digits', () => {
    // The anti-drift check — a threshold changed in one place and not the other
    // would otherwise pass every test above.
    for (const n of [0, 7, 100, 999, 1000, 8834, 2_000_000]) {
      const abbreviated = isPercentDeltaAbbreviated(n);
      const contains = formatPercentDelta(n).includes(String(n));
      expect(contains).toBe(!abbreviated);
    }
  });
});
