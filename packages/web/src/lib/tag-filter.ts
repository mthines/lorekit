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
  count: number;
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
 * Whether a memory carries EVERY selected label (conjunctive match).
 *
 * AND, not OR: selecting `perf` then `regression` means "memories about a perf
 * regression", which is what narrowing a list is for. An empty selection
 * matches everything, so the filter is inert until the user picks a label.
 *
 * This mirrors the server-side `.contains('tags', …)` predicate — it exists so
 * client-side surfaces (and tests) can apply the same rule without a round trip.
 */
export function matchesAllTags(
  row: { tags?: string[] | null },
  selected: readonly string[],
): boolean {
  const wanted = normalizeTags(selected);
  if (wanted.length === 0) return true;
  const owned = new Set(normalizeTags(row.tags));
  return wanted.every((tag) => owned.has(tag));
}

/**
 * The labels to render in the filter bar, capped at `limit`.
 *
 * Selected labels are always included even when they fall outside the cap —
 * an active filter chip that disappears from its own bar is unremovable
 * without editing the URL.
 */
export function visibleTags(
  catalog: readonly TagCount[],
  selected: readonly string[],
  limit: number,
): TagCount[] {
  if (limit <= 0) return [];
  const wanted = new Set(normalizeTags(selected));
  const head = catalog.slice(0, limit);
  const shown = new Set(head.map((t) => t.tag));
  const pinned = catalog.filter((t) => wanted.has(t.tag) && !shown.has(t.tag));
  return [...head, ...pinned];
}
