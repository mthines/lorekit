/**
 * Pure logic for the Lore Explorer's label (tag) filter.
 *
 * "Label" is the user-facing word for what the database stores as
 * `memories.tags` — the dashboard copy says Labels, the schema says tags, and
 * this module is the seam between the two vocabularies.
 *
 * Kept dependency-free (no React, no Supabase) so every decision the filter
 * makes is unit-testable in the node vitest project, mirroring `org-ui.ts`
 * and `pagination/filters.ts`.
 */

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
 */
export function normalizeTags(values: readonly unknown[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

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
 * Tally every label across a set of memories into `{ tag, count }` rows,
 * sorted by count descending then alphabetically so the ordering is stable
 * for equal counts (an unstable label bar reshuffles under the cursor).
 */
export function tallyTags(rows: readonly { tags?: string[] | null }[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of normalizeTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}


/**
 * The labels to render in the filter bar, capped at `limit`.
 *
 * Every selected label is included even when it falls outside the cap, and
 * even when the catalog does not contain it at all (an empty or failed catalog
 * fetch, or a label from a shared link that now matches nothing) — carried in
 * with `count: null`. An active filter whose chip is missing from its own bar
 * cannot be switched off without hand-editing the URL, which is the one state
 * this bar must never reach.
 */
export function visibleTags(
  catalog: readonly TagCount[],
  selected: readonly string[],
  limit: number,
): TagCount[] {
  const wanted = normalizeTags(selected);
  const wantedSet = new Set(wanted);
  const head = limit > 0 ? catalog.slice(0, limit) : [];
  const shown = new Set(head.map((t) => t.tag));

  const pinnedFromCatalog = catalog.filter((t) => wantedSet.has(t.tag) && !shown.has(t.tag));
  for (const t of pinnedFromCatalog) shown.add(t.tag);

  const uncatalogued: TagCount[] = wanted
    .filter((tag) => !shown.has(tag))
    .map((tag) => ({ tag, count: null }));

  return [...head, ...pinnedFromCatalog, ...uncatalogued];
}
