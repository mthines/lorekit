import { describe, it, expect } from 'vitest';
import {
  clampHighlight,
  filterOptions,
  firstEnabledIndex,
  initialHighlight,
  isSelected,
  lastEnabledIndex,
  nextEnabledIndex,
  selectionSummary,
  toggleSelection,
  withCreatableOption,
  type ComboboxOption,
} from './combobox-logic';

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

  it('opens on the FIRST selected option in OPTION order, not click order', () => {
    // The docblock's multi-select promise, and the only case that distinguishes
    // `isSelected(value, o.value)` from a scalar `o.value === value`: with the
    // list built as ['c', 'a'] the answer is 'a' at index 0, because the option
    // order decides, not the order the user ticked them in.
    expect(initialHighlight(OPTIONS, ['c', 'a'])).toBe(0);
    expect(initialHighlight(OPTIONS, ['c'])).toBe(2);
  });

  it('falls back to the first option for an EMPTY multi selection', () => {
    // Empty rather than null is the multi shape's "nothing picked", so it must
    // reach the same fallback the scalar `null` does.
    expect(initialHighlight(OPTIONS, [])).toBe(0);
  });

  it('skips a disabled option a multi selection names', () => {
    expect(initialHighlight(WITH_DISABLED, ['b'])).toBe(0);
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

describe('withCreatableOption', () => {
  const CANDIDATE: ComboboxOption = { value: 'd', label: 'd', hint: 'Use this scope' };

  it('appends the candidate, never prepends it', () => {
    // The highlight travels by INDEX over this array. A row at the front would
    // move every existing option under the user's highlight on the keystroke
    // that made the candidate valid.
    const out = withCreatableOption(OPTIONS, OPTIONS, CANDIDATE);
    expect(out.map((o) => o.value)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('offers nothing for a null candidate', () => {
    // `null` is how the caller says "what is typed is not a value I could
    // save". Offering a row the backend would reject is worse than none.
    expect(withCreatableOption(OPTIONS, OPTIONS, null)).toBe(OPTIONS);
  });

  it('does not re-offer a value that is already an option', () => {
    const dup: ComboboxOption = { value: 'b', label: 'b' };
    expect(withCreatableOption(OPTIONS, OPTIONS, dup)).toBe(OPTIONS);
  });

  it('does not re-offer a value already in `options` but filtered OUT of view', () => {
    // The filtered list is what the user sees; `options` is the authority on
    // what exists. Without this check, typing an exact existing value that the
    // filter happens to hide would offer to "create" a duplicate of it.
    const visible = filterOptions(OPTIONS, 'zzz');
    const dup: ComboboxOption = { value: 'c', label: 'c' };
    expect(withCreatableOption(visible, OPTIONS, dup)).toEqual([]);
  });

  it('appends onto an EMPTY filtered list, which is the common case', () => {
    // Typing a scope nobody has used yet matches no option, so this is the
    // path the escape hatch exists for.
    const visible = filterOptions(OPTIONS, 'zzz');
    expect(withCreatableOption(visible, OPTIONS, CANDIDATE).map((o) => o.value)).toEqual(['d']);
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

describe('isSelected', () => {
  it('matches a scalar selection by identity', () => {
    expect(isSelected('a', 'a')).toBe(true);
    expect(isSelected('a', 'b')).toBe(false);
  });

  it('matches membership of a list selection', () => {
    expect(isSelected(['a', 'c'], 'c')).toBe(true);
    expect(isSelected(['a', 'c'], 'b')).toBe(false);
  });

  it('treats an empty list and a null the same — nothing is selected', () => {
    // The two modes spell "nothing" differently; every caller downstream would
    // otherwise have to know which one it is holding.
    expect(isSelected([], 'a')).toBe(false);
    expect(isSelected(null, 'a')).toBe(false);
    expect(isSelected(undefined, 'a')).toBe(false);
  });
});

describe('toggleSelection', () => {
  it('adds a value that is absent', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes a value that is present', () => {
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('appends rather than sorting into the option order', () => {
    // The chip row reads back in the order the user built it. Re-sorting on
    // every click makes the row jump under the pointer.
    expect(toggleSelection(['c'], 'a')).toEqual(['c', 'a']);
  });

  it('always returns a new array', () => {
    // The result goes straight to `onChange`; a mutated input would not
    // re-render a `useState` holding the same reference.
    const before: string[] = ['a'];
    expect(toggleSelection(before, 'b')).not.toBe(before);
    expect(toggleSelection(before, 'a')).not.toBe(before);
    expect(before).toEqual(['a']);
  });

  it('removes every copy if a duplicate ever got in', () => {
    // Defensive: the control never writes a duplicate, but a caller's own state
    // can, and a toggle that only removed the first copy would look like a
    // click that did nothing.
    expect(toggleSelection(['a', 'a'], 'a')).toEqual([]);
  });
});

describe('selectionSummary', () => {
  it('reports null when nothing is selected, in either shape', () => {
    // Null, not '' — the caller falls back to the control's own name, and that
    // decision is not this function's to make.
    expect(selectionSummary(OPTIONS, null)).toBeNull();
    expect(selectionSummary(OPTIONS, [])).toBeNull();
  });

  it('uses the option label for exactly one selection', () => {
    expect(selectionSummary(OPTIONS, 'b')).toBe('Archived');
    expect(selectionSummary(OPTIONS, ['b'])).toBe('Archived');
  });

  it('counts past one, with the caller noun', () => {
    expect(selectionSummary(OPTIONS, ['a', 'b'])).toBe('2 selected');
    expect(selectionSummary(OPTIONS, ['a', 'b', 'c'], 'scopes')).toBe('3 scopes');
  });

  it('reports null for a SCALAR value outside the option set', () => {
    // NOT the raw value: the Overview's range picker legitimately holds one
    // (an absolute window drilled in from a chart) and documents that the
    // trigger then reads as the control's name unless `triggerLabel` overrides
    // it. Printing the raw value would regress that.
    expect(selectionSummary(OPTIONS, 'zzz')).toBeNull();
  });

  it('says the value for a ONE-ITEM list outside the option set', () => {
    // The scalar null has one caller that wants it; a list has none. Reporting
    // "none" for ['zzz'] while ['a', 'zzz'] reports "2 selected" would make the
    // trigger contradict itself on the same non-empty selection.
    expect(selectionSummary(OPTIONS, ['zzz'])).toBe('zzz');
    expect(selectionSummary(OPTIONS, ['zzz'], 'scopes')).toBe('zzz');
  });

  it('still counts unknown values in a multi selection', () => {
    // The count does not need labels, so an unrecognised member is no reason to
    // under-report how many things are selected.
    expect(selectionSummary(OPTIONS, ['a', 'zzz'])).toBe('2 selected');
  });
});
