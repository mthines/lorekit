/**
 * Combobox — the pure decisions.
 *
 * A single-select popup list makes three decisions that are worth testing
 * without a browser: which option the keyboard moves to, which options a query
 * leaves visible, and where the highlight sits when the list opens. Extracting
 * them keeps `Combobox.tsx` a thin view and puts the off-by-ones somewhere a
 * node test can reach — the repo's functional-core split, the same one
 * `bottom-sheet.ts` and `filters.ts` follow.
 */

export interface ComboboxOption<T extends string = string> {
  value: T;
  /** The visible text, and what a search query matches against. */
  label: string;
  /** Secondary line, shown under the label and also searched. */
  hint?: string;
  /** A disabled option stays visible (so its absence is not mysterious) but is unselectable. */
  disabled?: boolean;
}

/**
 * Move the highlight by `delta`, skipping disabled options and wrapping.
 *
 * Wrapping is deliberate: a three-option status list is faster to reach the last
 * item by pressing Up once than Down twice, and a list that silently stops at
 * its end gives no feedback that it did.
 *
 * Returns `-1` when there is nothing selectable — a list of only disabled
 * options must not spin forever looking for one, which is exactly what a naive
 * `while` loop does.
 */
export function nextEnabledIndex<O extends ComboboxOption>(
  options: readonly O[],
  from: number,
  delta: 1 | -1,
): number {
  const n = options.length;
  if (n === 0) return -1;
  // "Nothing highlighted" (-1) is a position OUTSIDE the list, and which side it
  // is on depends on the direction of travel: pressing Down should land on the
  // first option and pressing Up on the LAST. Left as a literal -1, the modulo
  // below sends Up to `n - 2` — it skips the last option, which is the one the
  // user was reaching for. So the sentinel is normalised per direction first.
  // `>= n` and not `> n`: `n` is itself outside the list (the last index is
  // `n - 1`), so `from = n` — what `lastEnabledIndex` passes — must normalise
  // too. Left as `> n`, a forward step from `n` landed on index 1 and skipped
  // index 0 entirely.
  const start = from < 0 || from >= n ? (delta === 1 ? -1 : n) : from;
  // Bounded by the list length: after n steps every option has been considered,
  // so anything still unfound does not exist. A `while (disabled)` search would
  // spin forever on an all-disabled list.
  for (let step = 1; step <= n; step++) {
    // +n keeps the modulo positive for the backwards case.
    const i = (((start + delta * step) % n) + n) % n;
    if (!options[i]?.disabled) return i;
  }
  return -1;
}

/** The first selectable option, or -1. Used by Home and by an opening list. */
export function firstEnabledIndex<O extends ComboboxOption>(
  options: readonly O[],
): number {
  return nextEnabledIndex(options, -1, 1);
}

/** The last selectable option, or -1. Used by End. */
export function lastEnabledIndex<O extends ComboboxOption>(
  options: readonly O[],
): number {
  return nextEnabledIndex(options, options.length, -1);
}

/**
 * Where the highlight goes when the list opens.
 *
 * On the CURRENT value, so the list opens showing you what you have rather than
 * making you find it — and pressing Down once moves to the neighbour, which is
 * what a native select does. Falls back to the first selectable option when the
 * value is absent, unknown, or points at a disabled option (a highlight that
 * cannot be activated by Enter is a dead end).
 */
export function initialHighlight<O extends ComboboxOption>(
  options: readonly O[],
  value: string | null | undefined,
): number {
  const i = options.findIndex((o) => o.value === value);
  if (i >= 0 && !options[i]?.disabled) return i;
  return firstEnabledIndex(options);
}

/**
 * Filter options by a query, case-insensitively, over label AND hint.
 *
 * The hint is searched because it carries the information that distinguishes
 * otherwise-similar options ("Expiring" vs "Live memories expiring within 7
 * days"), and a user typing "expiring" should not have to know which half of
 * the row they are matching.
 *
 * A blank query returns the list unchanged — the SAME array reference, so a
 * caller can use it as a memo dependency without re-rendering on every
 * keystroke that only added whitespace.
 */
export function filterOptions<O extends ComboboxOption>(
  options: readonly O[],
  query: string,
): readonly O[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(needle) ||
      (o.hint?.toLowerCase().includes(needle) ?? false),
  );
}

/**
 * Clamp a highlight index onto a (possibly re-filtered) list.
 *
 * Typing narrows the list under the highlight, so the index it held can point
 * past the end — at which point Enter would select nothing and the user would
 * conclude the control is broken. Re-homing to the first selectable option is
 * the behaviour every native combobox has.
 */
export function clampHighlight<O extends ComboboxOption>(
  options: readonly O[],
  highlight: number,
): number {
  if (highlight < 0 || highlight >= options.length) return firstEnabledIndex(options);
  return options[highlight]?.disabled ? firstEnabledIndex(options) : highlight;
}
