'use client';

/**
 * RetentionConditionsControl
 *
 * The Explorer's "Age & activity" filter: the same min-age / unseen / seen-at-
 * most trio a saved retention policy matches on (`lib/retention-filter.ts`),
 * exposed as a filter over the list rather than only as a preview count inside
 * the Settings → Retention Policies dialog. Setting one narrows the list to
 * the lessons a policy with these conditions would catch — verification before
 * a policy is ever saved.
 *
 * Deliberately an INLINE disclosure — a row that appears below the control row,
 * the same slot `FilterPillRow` occupies — rather than a floating popover.
 * `FilterMenu`'s popover/`BottomSheet` split exists because a categorical
 * dimension's value list is unbounded and needs its own scrollable surface;
 * three numeric inputs do not, so the simpler, portal-free disclosure is the
 * right amount of machinery for this control.
 */

import { useId } from 'react';
import { Clock, X } from 'lucide-react';
import {
  hasRetentionConditions,
  retentionConditionsCount,
  retentionConditionsPhrase,
  type RetentionConditions,
} from '@/lib/retention-filter';

const LABEL_CLASS = 'text-[11px] font-medium text-[var(--color-content-secondary)]';
const INPUT_CLASS =
  'h-8 w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';

/** The trigger button, rendered inside the control row beside the filter menu. */
export function RetentionConditionsTrigger({
  conditions,
  open,
  onToggle,
}: {
  conditions: RetentionConditions;
  open: boolean;
  onToggle: () => void;
}) {
  const active = hasRetentionConditions(conditions);
  const count = retentionConditionsCount(conditions);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={active ? retentionConditionsPhrase(conditions) : 'Age & activity filter'}
      className={[
        'flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150',
        active || open
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      <Clock className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">{active ? retentionConditionsPhrase(conditions) : 'Age & activity'}</span>
      {count > 0 && (
        <span className="flex size-4 items-center justify-center rounded-full bg-[var(--color-accent)] text-[9px] font-semibold text-[var(--color-bg)]">
          {count}
        </span>
      )}
    </button>
  );
}

/** The three numeric inputs, rendered in the disclosure row when the trigger is open. */
export function RetentionConditionsPanel({
  conditions,
  onChange,
  onClose,
}: {
  conditions: RetentionConditions;
  onChange: (next: RetentionConditions) => void;
  onClose: () => void;
}) {
  const minAgeId = useId();
  const unseenId = useId();
  const maxSeenId = useId();

  /** Parse one field's raw input into the condition set — blank clears it. */
  function setField(field: keyof RetentionConditions, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      const rest = { ...conditions };
      delete rest[field];
      onChange(rest);
      return;
    }
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 0) onChange({ ...conditions, [field]: n });
  }

  return (
    <div
      role="group"
      aria-label="Age and activity conditions"
      className="flex flex-wrap items-end gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={minAgeId} className={LABEL_CLASS}>Older than (days)</label>
        <input
          id={minAgeId}
          type="number"
          min={1}
          className={INPUT_CLASS}
          value={conditions.minAgeDays ?? ''}
          onChange={(e) => setField('minAgeDays', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={unseenId} className={LABEL_CLASS}>Unseen for (days)</label>
        <input
          id={unseenId}
          type="number"
          min={1}
          className={INPUT_CLASS}
          value={conditions.unseenDays ?? ''}
          onChange={(e) => setField('unseenDays', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={maxSeenId} className={LABEL_CLASS}>Seen at most (times)</label>
        <input
          id={maxSeenId}
          type="number"
          min={0}
          className={INPUT_CLASS}
          value={conditions.maxSeenCount ?? ''}
          onChange={(e) => setField('maxSeenCount', e.target.value)}
        />
      </div>
      <button
        type="button"
        onClick={onClose}
        className="ml-auto flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg)] hover:text-[var(--color-content-primary)]"
      >
        <X className="size-3.5" aria-hidden />
        Done
      </button>
    </div>
  );
}
