import { describe, expect, it } from 'vitest';

import { formatCompact, formatExact } from './format-number';

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
