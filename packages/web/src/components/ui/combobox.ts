/**
 * Combobox — the pure decisions.
 *
 * A popup list makes four decisions that are worth testing without a browser:
 * which option the keyboard moves to, which options a query leaves visible,
 * where the highlight sits when the list opens, and — in multi-select mode —
 * what the selection becomes when a row is toggled. Extracting them keeps
 * `Combobox.tsx` a thin view and puts the off-by-ones somewhere a node test can
 * reach — the repo's functional-core split, the same one `bottom-sheet.ts` and
 * `filters.ts` follow.
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
 * What a control's current selection looks like, in either mode.
 *
 * Single-select carries one value or `null`; multi-select carries a list, which
 * is empty rather than `null` when nothing is picked — "no tags" and "the tags
 * field is absent" are not different states, and collapsing them removes a
 * nullable every call site would otherwise have to defend against.
 */
export type ComboboxSelection<T extends string = string> = T | readonly T[] | null | undefined;

/**
 * Is `value` part of `selection`? The one place the two modes' shapes are
 * reconciled, so nothing else has to branch on `Array.isArray`.
 */
export function isSelected<T extends string>(selection: ComboboxSelection<T>, value: T): boolean {
  if (selection == null) return false;
  return Array.isArray(selection) ? selection.includes(value) : selection === value;
}

/**
 * Add or remove `value` from a multi-select selection.
 *
 * Appends on add rather than re-sorting into the option order: the list the user
 * built reads back in the order they built it, and a chip row that silently
 * reorders itself as you click is disorienting. Always returns a NEW array — the
 * caller hands this straight to `onChange`, and a mutated input would not
 * re-render a `useState` holding the same reference.
 */
export function toggleSelection<T extends string>(selection: readonly T[], value: T): T[] {
  return selection.includes(value) ? selection.filter((v) => v !== value) : [...selection, value];
}

/**
 * The trigger's text for a selection: nothing, the one label, or a count.
 *
 * A count rather than a truncated join once past one: "repo::a/b, repo::c/d, +3"
 * in a 240px trigger degrades to unreadable ellipsis at exactly the point the
 * selection is worth reading, and "5 selected" at least states the fact
 * accurately.
 *
 * `null` means "there is no text to show", and the caller falls back to the
 * control's own name — this function does not know it. A single value with no
 * matching option is one of those cases, NOT a reason to print the raw value:
 * the Overview's range picker legitimately holds a value outside its option set
 * (an absolute window drilled in from a chart) and documents that the trigger
 * then reads as the control's name unless `triggerLabel` overrides it. Printing
 * `2026-03-01T00:00:00Z/2026-03-08T00:00:00Z` in a 240px trigger would be a
 * regression dressed up as honesty.
 */
export function selectionSummary<O extends ComboboxOption>(
  options: readonly O[],
  selection: ComboboxSelection<string>,
  countNoun = 'selected',
): string | null {
  const values = selection == null ? [] : Array.isArray(selection) ? selection : [selection];
  if (values.length === 0) return null;
  if (values.length === 1) {
    return options.find((o) => o.value === values[0])?.label ?? null;
  }
  return `${values.length} ${countNoun}`;
}

/**
 * Where the highlight goes when the list opens.
 *
 * On the CURRENT value, so the list opens showing you what you have rather than
 * making you find it — and pressing Down once moves to the neighbour, which is
 * what a native select does. Falls back to the first selectable option when the
 * value is absent, unknown, or points at a disabled option (a highlight that
 * cannot be activated by Enter is a dead end).
 *
 * With a multi-select list it opens on the FIRST selected option in the option
 * order (not in click order) — the top of what you already have, which is where
 * a reader's eye goes anyway.
 */
export function initialHighlight<O extends ComboboxOption>(
  options: readonly O[],
  value: ComboboxSelection<string>,
): number {
  const i = options.findIndex((o) => isSelected(value, o.value));
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
