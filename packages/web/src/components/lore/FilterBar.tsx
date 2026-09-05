'use client';

/**
 * FilterBar
 *
 * The Lore Explorer's committed filters: a row of {@link FilterPill}s plus the
 * {@link FilterMenu} that adds to them, and a "Clear all" once there is more
 * than one.
 *
 * ## Where it sits, and why not in the control row
 * The menu's trigger lives in the control row beside search / date (it is a
 * control; Status rides along inside the same trigger's menu — see
 * `FilterMenu`). The pills live BELOW it, on their own line, because they
 * are state rather than controls: their number is unbounded, and pushing an
 * unbounded set into a fixed row either truncates the filters or truncates the
 * search box. The row collapses entirely when nothing is filtered, so the cost
 * of the whole feature to an unfiltered Explorer is zero pixels.
 *
 * ## Age & activity pills sit in the same row
 * The five retention thresholds are filters (see `FilterMenu`'s own header), so
 * they render as {@link RetentionPill}s alongside the dimension pills rather
 * than in a strip of their own. Dimensions first, thresholds after, matching the
 * menu's row order — one order to learn, not two.
 *
 * ## "Create retention policy" is an action ON the bar
 * The bar describes a set of lessons; saving that description as a policy is the
 * one thing you would do with it that the list itself cannot. It trails the
 * pills beside "Clear all" rather than sitting in a banner over the results: a
 * full-width banner overstated a follow-up to what the user just clicked, and
 * the previous home for it — inside the retention panel — disappeared with the
 * panel.
 *
 * ## Announcements
 * Toggling a value updates a pill outside the surface the user is looking at
 * (the menu is still open, and covers part of the list), so the change is
 * silent to a screen reader. A polite live region names the resulting filter
 * set — the one thing the visual user gets for free and the AT user does not.
 */

import { AnimatePresence } from 'motion/react';
import { Archive } from 'lucide-react';
import { FilterMenu } from './FilterMenu';
import { FilterPill } from './FilterPill';
import { RetentionPill } from './RetentionPill';
import { filtersPhrase, type FacetValue, type Filter, type FilterField, type FilterOperator } from '@/lib/filters';
import {
  NO_RETENTION_CONDITIONS,
  RETENTION_FIELDS,
  hasRetentionConditions,
  retentionConditionsPhrase,
  setRetentionCondition,
  type RetentionConditions,
  type RetentionField,
} from '@/lib/retention-filter';
import type { MemoryStatus } from '@/lib/status-filter';

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
  /** The Explorer's Status selection — see `FilterMenu`'s "Status lives here
   *  too" for why it rides along on the trigger rather than getting its own
   *  prop group. Optional so a caller with no status concept (none today)
   *  can omit both and get the plain filter-only menu. */
  status?: MemoryStatus;
  onStatusChange?: (status: MemoryStatus) => void;
  /**
   * The age/activity thresholds and their setter — optional TOGETHER, the same
   * way `status`/`onStatusChange` are, so a caller with no retention concept
   * (`GroomingRuleBuilder`, which reuses the same menu for a policy's dimension
   * filters) renders the bar without them. See `FilterMenu` for why this is not
   * a required prop with a default.
   */
  retention?: RetentionConditions;
  onRetentionChange?: (next: RetentionConditions) => void;
  /** Set by a retention pill's value segment to reopen the menu at that threshold. */
  editingRetentionField?: RetentionField | null;
  onEditRetentionField?: (field: RetentionField | null) => void;
  /**
   * Hands the whole bar — dimensions AND thresholds — off to Settings →
   * Retention Policies. Omitted when the caller has nowhere to hand it to, which
   * hides the action rather than rendering a dead one.
   */
  onCreatePolicy?: () => void;
}

/** The menu trigger alone — rendered inside the control row. */
export function FilterMenuTrigger({
  facets,
  filters,
  onToggleValue,
  status,
  onStatusChange,
  retention,
  onRetentionChange,
  editingField,
  onEditField,
  editingRetentionField = null,
  onEditRetentionField,
  variant,
}: Pick<
  FilterBarProps,
  | 'facets'
  | 'filters'
  | 'onToggleValue'
  | 'status'
  | 'onStatusChange'
  | 'retention'
  | 'onRetentionChange'
  | 'editingField'
  | 'onEditField'
  | 'editingRetentionField'
  | 'onEditRetentionField'
  | 'variant'
>) {
  return (
    <FilterMenu
      facets={facets}
      filters={filters}
      onToggleValue={onToggleValue}
      status={status}
      onStatusChange={onStatusChange}
      retention={retention}
      onRetentionChange={onRetentionChange}
      variant={variant}
      openAtField={editingField}
      onOpenAtFieldHandled={() => onEditField(null)}
      openAtRetentionField={editingRetentionField}
      onOpenAtRetentionFieldHandled={() => onEditRetentionField?.(null)}
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
  retention = NO_RETENTION_CONDITIONS,
  onRetentionChange,
  onEditRetentionField,
  onCreatePolicy,
}: Pick<
  FilterBarProps,
  | 'filters'
  | 'onOperatorChange'
  | 'onRemove'
  | 'onClearAll'
  | 'onEditField'
  | 'retention'
  | 'onRetentionChange'
  | 'onEditRetentionField'
  | 'onCreatePolicy'
>) {
  // Walk `RETENTION_FIELDS` rather than `Object.entries(retention)`: the pills
  // then sit in the menu's own row order regardless of the order the URL param
  // happened to serialise its keys in.
  const retentionPills = RETENTION_FIELDS.flatMap(({ field }) => {
    const value = retention[field];
    return value === undefined ? [] : [{ field, value }];
  });

  if (filters.length === 0 && retentionPills.length === 0) return null;

  // More than one thing to clear — a lone pill already has its own ×.
  const showClearAll = filters.length + retentionPills.length > 1;

  // Both halves of the bar, in the order they render. A threshold change is as
  // silent to a screen reader as a dimension one — the menu is still open and
  // covering the list — so announcing only the dimensions would have left half
  // the bar unannounced.
  const announcement = [
    filters.length > 0 ? filtersPhrase(filters) : null,
    hasRetentionConditions(retention) ? retentionConditionsPhrase(retention) : null,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
      <p aria-live="polite" className="sr-only">
        {announcement}
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
        {retentionPills.map(({ field, value }) => (
          <RetentionPill
            key={field}
            field={field}
            value={value}
            onEditValue={() => onEditRetentionField?.(field)}
            onRemove={() => onRetentionChange?.(setRetentionCondition(retention, field, undefined))}
          />
        ))}
      </AnimatePresence>
      {showClearAll && (
        <button
          type="button"
          onClick={() => {
            onClearAll();
            onRetentionChange?.(NO_RETENTION_CONDITIONS);
          }}
          className="ml-0.5 flex min-h-7 items-center rounded-lg px-2 text-[11px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
        >
          Clear all
        </button>
      )}
      {onCreatePolicy && (
        // Trailing, and after "Clear all", so it never shifts as pills come and
        // go. Subtle rather than a filled accent button: it is an offer made on
        // every filtered view, not the thing the user came to the Explorer to do.
        <button
          type="button"
          onClick={onCreatePolicy}
          className="ml-auto flex min-h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2 text-[11px] font-medium text-[var(--color-content-secondary)] transition-colors duration-100 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)]"
        >
          <Archive className="size-3 shrink-0" aria-hidden />
          Create retention policy
        </button>
      )}
    </div>
  );
}
