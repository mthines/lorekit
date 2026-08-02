/**
 * Pure logic for the Lore Explorer's label (tag) filter.
 *
 * "Label" is the user-facing word for what the database stores as
 * `memories.tags` — the dashboard copy says Labels, the schema says tags, and
 * this module is the seam between the two vocabularies.
 *
 * Kept dependency-free (no React, no Supabase) so every decision the filter
 * makes is unit-testable in the node vitest project, mirroring `org-ui.ts`
 * and `pagination/filters.ts`. The two primitives the SERVER also needs —
 * label normalisation and Postgres array quoting — live in
 * `@lorekit/schemas/tags` (itself dependency-free) and are re-exported below,
 * so the picker and the `GET /memories` handler can never disagree about what
 * a label list means.
 */

import { normalizeTagList, pgArrayLiteral } from '@lorekit/schemas/tags';

export interface TagCount {
  tag: string;
  /**
   * How many memories carry the label, or `null` when that is unknown — a
   * selected label the catalog does not cover (an empty or failed catalog
   * fetch, or a label from a shared link that no longer matches anything).
   * Renderers show a count only when it is a real number; inventing `0` for an
   * unknown would state something false about the data.
   */
  count: number | null;
}

/**
 * Trim, drop empties, and dedupe a raw label list, preserving first-seen order.
 *
 * Total function: `undefined`, a non-array, or an array holding non-strings all
 * degrade to the labels that ARE usable rather than throwing — the input can
 * come from a URL param a user typed by hand.
 *
 * Re-exported from `@lorekit/schemas/tags` rather than re-implemented: the
 * `GET /memories` handler normalizes the `tags` query param with the SAME
 * function, so the labels the picker sends and the labels the server filters on
 * cannot drift. The alias keeps the dashboard's `normalizeTags` name.
 */
export const normalizeTags = normalizeTagList;

/**
 * Add `tag` to the selection when absent, remove it when present.
 * The result is normalized, so a toggle can never introduce a duplicate or an
 * empty label into the URL.
 */
export function toggleTag(selected: readonly string[], tag: string): string[] {
  const normalizedSelection = normalizeTags(selected);
  const trimmed = tag.trim();
  if (!trimmed) return normalizedSelection;
  return normalizedSelection.includes(trimmed)
    ? normalizedSelection.filter((t) => t !== trimmed)
    : [...normalizedSelection, trimmed];
}

/**
 * Build a PostgreSQL array literal (`{"a","b,c"}`) from a label list.
 *
 * Lives in `@lorekit/schemas/tags` because the edge `GET /memories` handler
 * needs the identical quoting for its `tags_mode=all` branch and the edge tree
 * cannot import this package. Re-exported here so the dashboard's existing
 * import path is unchanged.
 */
export { pgArrayLiteral };

/**
 * The full option list for the label picker: the catalog, plus any selected
 * label the catalog does not cover (an empty or failed catalog fetch, or a
 * label from a shared link that now matches nothing) appended with
 * `count: null`.
 *
 * Catalog order is preserved and selected options are NOT hoisted to the top:
 * a list that reorders itself on every toggle moves the next option out from
 * under the pointer mid-click. An option's selected state is shown in place.
 *
 * The uncatalogued tail is what guarantees a selected label always has a row
 * to switch it off — an active filter you can only clear by hand-editing the
 * URL is the one state this control must never reach.
 */
export function tagOptions(
  catalog: readonly TagCount[],
  selected: readonly string[],
): TagCount[] {
  const known = new Set(catalog.map((t) => t.tag));
  const uncatalogued: TagCount[] = normalizeTags(selected)
    .filter((tag) => !known.has(tag))
    .map((tag) => ({ tag, count: null }));

  return [...catalog, ...uncatalogued];
}

/**
 * Narrow an option list by the picker's search box: case-insensitive substring
 * against the label text. A blank or whitespace-only query matches everything.
 *
 * Substring, not prefix or fuzzy: labels are frequently namespaced (`ci/flaky`,
 * `perf-regression`), so the memorable fragment is often in the middle, and a
 * fuzzy matcher would surface confusing hits for a set this small.
 *
 * The query is matched literally — no regex is compiled from user input.
 */
export function searchTags(options: readonly TagCount[], query: string): TagCount[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => option.tag.toLowerCase().includes(needle));
}

/**
 * The trigger's summary text: `Labels` when nothing is picked, the single label
 * when one is, and `<first> +N` beyond that.
 *
 * The first label is named rather than showing a bare count, because "perf +2"
 * tells you what the list is filtered by without opening the picker, while
 * "3 labels" does not.
 */
export function tagTriggerLabel(selected: readonly string[]): string {
  const picked = normalizeTags(selected);
  if (picked.length === 0) return 'Labels';
  if (picked.length === 1) return picked[0] as string;
  return `${picked[0]} +${picked.length - 1}`;
}
