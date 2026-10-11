'use client';

/**
 * SortSelect — the Lore Explorer's list order (`?sort=`, `lib/explorer-sort.ts`).
 *
 * A native `<select>`, the way `MatrixInstrument` picks its axes: the choice is
 * one of a small closed set, so the platform control gives keyboard support, a
 * screen-reader name and — on a phone — the OS picker for free, where a custom
 * popover would have to rebuild all three.
 *
 * It sits in the control row rather than inside the Filter menu because an
 * order is not a filter: it narrows nothing, and a reader looking for "most
 * chosen first" scans the toolbar, not a list of dimensions. Like the Filter
 * trigger, it takes the accent tint while it departs from the default, so the
 * toolbar always says when the list is not in its usual order.
 */

import { ArrowDownWideNarrow, ChevronDown } from 'lucide-react';
import {
  DEFAULT_EXPLORER_SORT,
  EXPLORER_SORTS,
  EXPLORER_SORT_LABELS,
  type ExplorerSort,
} from '@/lib/explorer-sort';

interface SortSelectProps {
  value: ExplorerSort;
  onChange: (sort: ExplorerSort) => void;
  /** `desktop` uses the dense toolbar type; `mobile` the larger touch type. */
  variant: 'desktop' | 'mobile';
  className?: string;
}

export function SortSelect({ value, onChange, variant, className = '' }: SortSelectProps) {
  const desktop = variant === 'desktop';
  const nonDefault = value !== DEFAULT_EXPLORER_SORT;

  return (
    <div className={`relative flex shrink-0 items-center ${className}`}>
      <ArrowDownWideNarrow
        className={[
          'pointer-events-none absolute left-2.5 size-3.5',
          nonDefault ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-tertiary)]',
        ].join(' ')}
        aria-hidden
      />
      <select
        value={value}
        // The options ARE `EXPLORER_SORTS`, so the cast cannot admit a value
        // the type does not describe.
        onChange={(e) => onChange(e.target.value as ExplorerSort)}
        aria-label="Sort memories"
        title={desktop ? 'Sort memories' : undefined}
        className={[
          'min-h-9 cursor-pointer appearance-none rounded-lg border py-1.5 pl-8 pr-7 font-medium transition-colors duration-150 focus:outline-none focus-visible:border-[var(--color-accent)]',
          desktop ? 'text-xs' : 'text-sm',
          nonDefault
            ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
        ].join(' ')}
      >
        {EXPLORER_SORTS.map((sort) => (
          <option key={sort} value={sort}>
            {EXPLORER_SORT_LABELS[sort]}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 size-3.5 text-[var(--color-content-tertiary)]"
        aria-hidden
      />
    </div>
  );
}
