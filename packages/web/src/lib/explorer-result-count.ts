/**
 * explorer-result-count
 *
 * Pure decision of what the header's memory count should say while the Lore
 * Explorer is mounted (see `ExplorerResultsProvider`).
 *
 * The header's `MemoryExpandButton` shows a bare account-wide total
 * everywhere in the dashboard. On `/lore` it can do better: when the
 * Explorer's own view narrows the active population — a scope, a search
 * term, a filter pill, a retention condition, or a date range — the header
 * can say how many of that total the current view actually matches
 * ("12 of 128 memories") instead of a number that silently ignores the
 * filter the reader is looking at.
 */

/**
 * Whether the Explorer's current view narrows the account's ACTIVE
 * memories at all.
 *
 * Deliberately excludes the Archived view: it lists a DIFFERENT population
 * than the header's active total, so pairing an archived count with the
 * active total would misinform rather than clarify (`showArchived` is the
 * exclusion). The Expiring view stays included — it is a genuine subset of
 * the active population, so "of <active total>" is still a fair comparison.
 */
export function isExplorerViewFiltered(input: {
  scope: string | null;
  search: string;
  filterCount: number;
  hasRetentionConditions: boolean;
  rangeIsNarrowing: boolean;
  showArchived: boolean;
}): boolean {
  if (input.showArchived) return false;
  return (
    input.scope !== null ||
    input.search.trim() !== '' ||
    input.filterCount > 0 ||
    input.hasRetentionConditions ||
    input.rangeIsNarrowing
  );
}

/**
 * The header's label for a filtered Explorer view.
 *
 * `matchedCount` is exact only once every matching page has loaded
 * (`isExact`); short of that it is a floor — `useMemories` never fetches a
 * page it doesn't need to render, so the true matching count is unknown
 * until pagination is exhausted. The trailing `+` keeps that distinction
 * visible rather than a number that reads as final.
 */
export function explorerCountLabel(matchedCount: number, isExact: boolean, total: number): string {
  return `${matchedCount}${isExact ? '' : '+'} of ${total}`;
}
