'use client';

/**
 * FilterableMetaValue — wraps a metadata VALUE in the detail panel with a
 * hover-reveal "Filter by this" affordance (R3, lore-explorer-panel-nav-facets).
 *
 * The affordance is an icon-only `IconButton` (ghost, smallest size), which
 * already wraps itself in a `Tooltip` showing `label` (see `Button.tsx`) — so
 * this component adds only the hover-reveal chrome, not a second tooltip layer.
 *
 * Per the IconButton footgun (this repo's accumulated lesson): a positioning
 * className passed straight into `IconButton` can collapse its own `Tooltip`
 * wrapper, because that wrapper does not establish a positioning context for
 * an absolutely-positioned child. The safe pattern is to put any layout
 * className (here: the hover/focus opacity reveal) on a plain WRAPPING
 * element instead, leaving `IconButton` itself unmodified. The wrapper below
 * is an inline `<span>` rather than a `<div>` because every call site
 * (`LessonDetailSheet`'s `dd` rows, `MemoryOrigin`'s rows) is already an
 * `items-center` flex row, and a block-level wrapper would push the
 * affordance onto its own line.
 */

import type { ReactNode } from 'react';
import { ListFilter } from 'lucide-react';
import { IconButton } from './Button';

interface FilterableMetaValueProps {
  /** The rendered value — a chip, a link, or plain text. */
  children: ReactNode;
  /** Accessible name / tooltip for the affordance, e.g. `Filter by host "reviewer"`. */
  label: string;
  onFilter: () => void;
}

export function FilterableMetaValue({ children, label, onFilter }: FilterableMetaValueProps) {
  return (
    <span className="group/filterable inline-flex min-w-0 items-center gap-1">
      {children}
      <span className="shrink-0 opacity-0 transition-opacity duration-150 group-hover/filterable:opacity-100 group-focus-within/filterable:opacity-100">
        <IconButton
          variant="ghost"
          size="sm"
          icon={<ListFilter className="size-3" />}
          label={label}
          analyticsId="lesson-detail.filter-by-metadata"
          onClick={onFilter}
        />
      </span>
    </span>
  );
}
