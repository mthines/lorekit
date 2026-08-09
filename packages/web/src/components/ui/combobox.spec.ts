import { describe, it, expect } from 'vitest';
import {
  clampHighlight,
  filterOptions,
  firstEnabledIndex,
  initialHighlight,
  lastEnabledIndex,
  nextEnabledIndex,
  type ComboboxOption,
} from './combobox';

const OPTIONS: ComboboxOption[] = [
  { value: 'a', label: 'Active', hint: 'Live memories' },
  { value: 'b', label: 'Archived', hint: 'Archived memories' },
  { value: 'c', label: 'Expiring', hint: 'Live memories expiring within 7 days' },
];

const WITH_DISABLED: ComboboxOption[] = [
  { value: 'a', label: 'Active' },
  { value: 'b', label: 'Archived', disabled: true },
  { value: 'c', label: 'Expiring' },
];

describe('nextEnabledIndex', () => {
  it('steps forward and backward', () => {
    expect(nextEnabledIndex(OPTIONS, 0, 1)).toBe(1);
    expect(nextEnabledIndex(OPTIONS, 1, -1)).toBe(0);
  });

  it('wraps at both ends', () => {
    // Reaching the last item with one Up beats two Downs, and a list that
    // silently stops gives no feedback that it did.
    expect(nextEnabledIndex(OPTIONS, 2, 1)).toBe(0);
    expect(nextEnabledIndex(OPTIONS, 0, -1)).toBe(2);
  });

  it('starts from the top when nothing is highlighted', () => {
    expect(nextEnabledIndex(OPTIONS, -1, 1)).toBe(0);
    expect(nextEnabledIndex(OPTIONS, -1, -1)).toBe(2);
  });

  it('skips a disabled option in both directions', () => {
    expect(nextEnabledIndex(WITH_DISABLED, 0, 1)).toBe(2);
    expect(nextEnabledIndex(WITH_DISABLED, 2, -1)).toBe(0);
  });

  it('normalises an out-of-range `from` in BOTH directions', () => {
    // `n` is one past the last index, so it is outside the list exactly like
    // -1 is. Forward from there must land on the FIRST option — with the guard
    // written `from > n` it landed on index 1 and skipped index 0 — and
    // backward from there must still land on the last, which is what
    // `lastEnabledIndex` relies on.
    expect(nextEnabledIndex(OPTIONS, OPTIONS.length, 1)).toBe(0);
    expect(nextEnabledIndex(OPTIONS, OPTIONS.length, -1)).toBe(2);
    expect(nextEnabledIndex(OPTIONS, OPTIONS.length + 5, 1)).toBe(0);
  });

  it('returns -1 for an empty list rather than a bogus index', () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });

  it('TERMINATES when every option is disabled', () => {
    // The discriminating case for the bounded loop: a naive `while (disabled)`
    // search spins forever here and hangs the tab.
    const allDisabled: ComboboxOption[] = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B', disabled: true },
    ];
    expect(nextEnabledIndex(allDisabled, 0, 1)).toBe(-1);
    expect(nextEnabledIndex(allDisabled, 0, -1)).toBe(-1);
  });
});

describe('firstEnabledIndex / lastEnabledIndex', () => {
  it('find the ends of a plain list', () => {
    expect(firstEnabledIndex(OPTIONS)).toBe(0);
    expect(lastEnabledIndex(OPTIONS)).toBe(2);
  });

  it('skip disabled options at the ends', () => {
    const edged: ComboboxOption[] = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C', disabled: true },
    ];
    expect(firstEnabledIndex(edged)).toBe(1);
    expect(lastEnabledIndex(edged)).toBe(1);
  });

  it('report -1 for an empty list', () => {
    expect(firstEnabledIndex([])).toBe(-1);
    expect(lastEnabledIndex([])).toBe(-1);
  });
});

describe('initialHighlight', () => {
  it('opens on the current value, so the list shows what you already have', () => {
    expect(initialHighlight(OPTIONS, 'c')).toBe(2);
  });

  it('falls back to the first option when the value is absent or unknown', () => {
    expect(initialHighlight(OPTIONS, null)).toBe(0);
    expect(initialHighlight(OPTIONS, undefined)).toBe(0);
    expect(initialHighlight(OPTIONS, 'nope')).toBe(0);
  });

  it('does not open on a DISABLED current value', () => {
    // A highlight Enter cannot activate is a dead end — the user presses Enter,
    // nothing happens, and the control looks broken.
    expect(initialHighlight(WITH_DISABLED, 'b')).toBe(0);
  });

  it('reports -1 when nothing is selectable', () => {
    expect(initialHighlight([], 'a')).toBe(-1);
  });
});

describe('filterOptions', () => {
  it('matches the label, case-insensitively', () => {
    expect(filterOptions(OPTIONS, 'ARCH').map((o) => o.value)).toEqual(['b']);
  });

  it('matches the HINT too', () => {
    // The hint carries what distinguishes otherwise-similar rows; a user typing
    // "7 days" should not have to know which half of the row they are matching.
    expect(filterOptions(OPTIONS, '7 days').map((o) => o.value)).toEqual(['c']);
  });

  it('returns the SAME reference for a blank query', () => {
    // So a caller can use the result as a memo dependency without re-rendering
    // on a keystroke that only added whitespace.
    expect(filterOptions(OPTIONS, '')).toBe(OPTIONS);
    expect(filterOptions(OPTIONS, '   ')).toBe(OPTIONS);
  });

  it('returns an empty list for a query nothing matches', () => {
    expect(filterOptions(OPTIONS, 'zzz')).toEqual([]);
  });

  it('keeps disabled options visible', () => {
    // Filtering them out would make their absence look like a missing feature
    // rather than an unavailable choice.
    expect(filterOptions(WITH_DISABLED, 'archived').map((o) => o.value)).toEqual(['b']);
  });
});

describe('clampHighlight', () => {
  it('leaves a valid highlight alone', () => {
    expect(clampHighlight(OPTIONS, 1)).toBe(1);
  });

  it('re-homes a highlight that the filter left past the end', () => {
    // Typing narrows the list under the highlight; without this, Enter selects
    // nothing and the control reads as broken.
    expect(clampHighlight(filterOptions(OPTIONS, 'arch'), 2)).toBe(0);
  });

  it('re-homes off a disabled option', () => {
    expect(clampHighlight(WITH_DISABLED, 1)).toBe(0);
  });

  it('reports -1 when the filter left nothing', () => {
    expect(clampHighlight(filterOptions(OPTIONS, 'zzz'), 0)).toBe(-1);
  });
});
