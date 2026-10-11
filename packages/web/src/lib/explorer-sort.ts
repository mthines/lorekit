/**
 * The Lore Explorer's list order — the `?sort=` URL param.
 *
 * Two orders, both descending:
 *
 * - `created_at` — **Newest**, the default and the order the list has always
 *   had (`listMemories` used to hard-code it so a backdated migration lands at
 *   its original position).
 * - `opened_count` — **Most chosen**, migration 00113: the lessons agents
 *   deliberately fetched the most, first. It is the direct answer to "which
 *   lore is actually used?", where a `Chosen: N times or more` threshold makes
 *   the reader guess an N first.
 *
 * `updated_at` is a legal API sort but is not offered: a re-write bumps it, so
 * as a list order it mostly re-states recurrence, which `Recurrence` already
 * filters on.
 *
 * Pure, so the URL handling is unit-tested without a browser.
 */

export const EXPLORER_SORTS = ['created_at', 'opened_count'] as const;
export type ExplorerSort = (typeof EXPLORER_SORTS)[number];

/** The order an absent `?sort=` means. */
export const DEFAULT_EXPLORER_SORT: ExplorerSort = 'created_at';

/** The visible option text. Short: the control shares a row with search, Filter and the date picker. */
export const EXPLORER_SORT_LABELS: Record<ExplorerSort, string> = {
  created_at: 'Newest',
  opened_count: 'Most chosen',
};

/**
 * Read a `?sort=` value. Anything that is not one of {@link EXPLORER_SORTS} —
 * a hand-edited link, a value from a later version — falls back to the default
 * rather than reaching the API, where it would be a 400 and an empty list.
 */
export function resolveExplorerSort(raw: unknown): ExplorerSort {
  return EXPLORER_SORTS.includes(raw as ExplorerSort) ? (raw as ExplorerSort) : DEFAULT_EXPLORER_SORT;
}

/**
 * What to write to `?sort=` — `null` drops the param for the default, so an
 * unsorted Explorer link stays exactly as short as it was before sorting existed.
 */
export function explorerSortParamValue(sort: ExplorerSort): ExplorerSort | null {
  return sort === DEFAULT_EXPLORER_SORT ? null : sort;
}
