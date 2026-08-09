'use client';

/**
 * StatusControl — the Explorer's active / archived / expiring selector.
 *
 * Replaces the `archived` on/off button. A segmented control rather than a
 * third filter pill, deliberately: status is the one dimension a memory always
 * has EXACTLY ONE of, so it is a single-select over a closed set of three —
 * which is a radiogroup, not a filter whose values combine. Putting it in the
 * filter bar as a pill would also let a user construct "Status is either of
 * active, archived", which is just "no filter" spelled at length.
 *
 * It sits in the toolbar where the archived button was, so the control that
 * changes the population stays beside the controls that narrow it, and the row
 * gains no new line.
 *
 * Mirrors `StatRangeSelect`'s markup and ARIA (`role="radiogroup"` with
 * `role="radio"` children, `aria-checked`) — the dashboard already had one
 * single-select segmented control and a second one should not invent a
 * different keyboard contract.
 */

import { Archive, BookOpen, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  MEMORY_STATUSES,
  STATUS_HINTS,
  STATUS_LABELS,
  type MemoryStatus,
} from '@/lib/status-filter';

/**
 * One icon per state, so the control is recognisable at the icon-only width the
 * phone layout collapses it to.
 */
const STATUS_ICONS: Record<MemoryStatus, LucideIcon> = {
  active: BookOpen,
  archived: Archive,
  expiring: Clock,
};

interface StatusControlProps {
  value: MemoryStatus;
  onChange: (status: MemoryStatus) => void;
  /**
   * `desktop` shows icon + label; `mobile` collapses to icons, matching how the
   * rest of the toolbar responds. The accessible name carries the label and its
   * hint in both, so collapsing costs a sighted user width and a screen-reader
   * user nothing.
   */
  variant?: 'desktop' | 'mobile';
  className?: string;
}

export function StatusControl({
  value,
  onChange,
  variant = 'desktop',
  className = '',
}: StatusControlProps) {
  const desktop = variant === 'desktop';

  return (
    <div
      role="radiogroup"
      aria-label="Status"
      className={[
        'flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5',
        className,
      ].join(' ')}
    >
      {MEMORY_STATUSES.map((status) => {
        const Icon = STATUS_ICONS[status];
        const active = value === status;
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={active}
            // Label AND hint: "Expiring" alone does not say over what horizon,
            // and the control is too small to spell it out visually.
            aria-label={`${STATUS_LABELS[status]} — ${STATUS_HINTS[status]}`}
            title={STATUS_HINTS[status]}
            onClick={() => onChange(status)}
            className={[
              // min-h-9 keeps the hit target at the toolbar's height; the repo's
              // touch-target rule is what stops a segmented control shrinking to
              // something unhittable on a phone.
              'flex min-h-9 items-center justify-center rounded-md transition-colors duration-150',
              desktop ? 'gap-1.5 px-2.5 text-xs font-medium' : 'px-2.5',
              active
                ? 'bg-[var(--color-bg-raised)] text-[var(--color-content-primary)] shadow-sm'
                : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
            ].join(' ')}
          >
            <Icon className={desktop ? 'size-3.5' : 'size-4'} aria-hidden />
            {desktop && <span className="hidden sm:inline">{STATUS_LABELS[status]}</span>}
          </button>
        );
      })}
    </div>
  );
}
