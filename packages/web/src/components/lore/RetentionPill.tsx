'use client';

/**
 * RetentionPill
 *
 * One committed age/activity threshold in the Lore Explorer's filter bar,
 * sitting in the same row as the {@link FilterPill}s because it narrows the
 * list exactly as they do (migration 00108 gave the aggregates the same five
 * conditions, so the facet counts, the stat cards and the matrix all agree with
 * the rows underneath).
 *
 * Three segments where a `FilterPill` has four:
 *
 *   [icon + Created] [More than 30 days ago] [×]
 *
 * The **operator segment is absent, not empty**. A dimension can include or
 * exclude, so its middle segment is a real choice; a threshold's comparison is
 * baked into the condition itself (`min_age_days` is always "at least",
 * `max_opened_count` always "at most"), and the value's own wording carries it —
 * "More than 30 days ago", "Never chosen". Rendering an inert `is` segment would
 * put a third of the pill's width into a word that answers nothing.
 *
 * The type segment stays inert for the same reason it is in `FilterPill`:
 * changing a threshold's field would invalidate the value it holds, so the
 * honest affordance is remove-and-add.
 */

import { motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import {
  requireRetentionField,
  type RetentionField,
} from '@/lib/retention-filter';
import { RETENTION_FIELD_ICONS } from './FilterMenu';

interface RetentionPillProps {
  field: RetentionField;
  value: number;
  /** Reopens the filter menu at this threshold's value list. */
  onEditValue: () => void;
  onRemove: () => void;
}

export function RetentionPill({ field, value, onEditValue, onRemove }: RetentionPillProps) {
  const reduceMotion = useReducedMotion();
  const descriptor = requireRetentionField(field);
  const Icon = RETENTION_FIELD_ICONS[field];

  // The full sentence, for the pill's accessible name and every `aria-label`
  // built from it — the visible segments split it across two elements, and a
  // screen reader should hear the condition rather than two fragments.
  const phrase = `${descriptor.label}: ${descriptor.formatValue(value)}`;

  const segment = 'flex min-h-7 items-center px-2 text-[11px] transition-colors duration-100';

  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-stretch overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
      aria-label={phrase}
    >
      {/* Type — inert by design; a <span>, not a disabled button, so it is
          announced as a label rather than as a control that refuses to work. */}
      <span
        className={`${segment} gap-1.5 border-r border-[var(--color-border)] font-medium text-[var(--color-content-secondary)]`}
      >
        <Icon className="size-3 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        {descriptor.label}
      </span>

      {/* Value — the one segment that opens the menu. `title` carries the rule
          the threshold tests, which is the thing the menu shows under its own
          value list and which a pill has no room for. */}
      <button
        type="button"
        onClick={onEditValue}
        aria-label={`${phrase} — change value`}
        title={descriptor.hint}
        className={`${segment} max-w-48 truncate font-medium text-[var(--color-content-primary)] hover:bg-[var(--color-bg-elevated)]`}
      >
        <span className="truncate">{descriptor.formatValue(value)}</span>
      </button>

      {/* Remove — 28px tall and 24px wide, clearing WCAG 2.5.8's minimum. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${phrase}`}
        className="flex min-h-7 w-6 shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-content-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
      >
        <X className="size-3" aria-hidden />
      </button>
    </motion.div>
  );
}
