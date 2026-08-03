'use client';

/**
 * FilterBar
 *
 * The Lore Explorer's committed filters: a row of {@link FilterPill}s plus the
 * {@link FilterMenu} that adds to them, and a "Clear all" once there is more
 * than one.
 *
 * ## Where it sits, and why not in the control row
 * The menu's trigger lives in the control row beside search / date / archived
 * (it is a control). The pills live BELOW it, on their own line, because they
 * are state rather than controls: their number is unbounded, and pushing an
 * unbounded set into a fixed row either truncates the filters or truncates the
 * search box. The row collapses entirely when nothing is filtered, so the cost
 * of the whole feature to an unfiltered Explorer is zero pixels.
 *
 * ## Announcements
 * Toggling a value updates a pill outside the surface the user is looking at
 * (the menu is still open, and covers part of the list), so the change is
 * silent to a screen reader. A polite live region names the resulting filter
 * set — the one thing the visual user gets for free and the AT user does not.
 */

import { AnimatePresence } from 'motion/react';
import { FilterMenu } from './FilterMenu';
import { FilterPill } from './FilterPill';
import { filtersPhrase, type FacetValue, type Filter, type FilterField, type FilterOperator } from '@/lib/filters';

interface FilterBarProps {
  facets: FacetValue[];
  filters: Filter[];
  onToggleValue: (field: FilterField, value: string) => void;
  onOperatorChange: (field: FilterField, operator: FilterOperator) => void;
  onRemove: (field: FilterField) => void;
  onClearAll: () => void;
  /** Set by a pill's value segment to reopen the menu at that dimension. */
  editingField: FilterField | null;
  onEditField: (field: FilterField | null) => void;
  variant: 'desktop' | 'mobile';
}

/** The menu trigger alone — rendered inside the control row. */
export function FilterMenuTrigger({
  facets,
  filters,
  onToggleValue,
  editingField,
  onEditField,
  variant,
}: Pick<
  FilterBarProps,
  'facets' | 'filters' | 'onToggleValue' | 'editingField' | 'onEditField' | 'variant'
>) {
  return (
    <FilterMenu
      facets={facets}
      filters={filters}
      onToggleValue={onToggleValue}
      variant={variant}
      openAtField={editingField}
      onOpenAtFieldHandled={() => onEditField(null)}
      className="shrink-0"
    />
  );
}

/** The committed pills. Renders nothing at all when no filter is applied. */
export function FilterPillRow({
  filters,
  onOperatorChange,
  onRemove,
  onClearAll,
  onEditField,
}: Pick<
  FilterBarProps,
  'filters' | 'onOperatorChange' | 'onRemove' | 'onClearAll' | 'onEditField'
>) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
      <p aria-live="polite" className="sr-only">
        {filtersPhrase(filters)}
      </p>
      <AnimatePresence initial={false}>
        {filters.map((filter) => (
          <FilterPill
            key={filter.field}
            filter={filter}
            onOperatorChange={(op) => onOperatorChange(filter.field, op)}
            onEditValues={() => onEditField(filter.field)}
            onRemove={() => onRemove(filter.field)}
          />
        ))}
      </AnimatePresence>
      {filters.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="ml-0.5 flex min-h-7 items-center rounded-lg px-2 text-[11px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
