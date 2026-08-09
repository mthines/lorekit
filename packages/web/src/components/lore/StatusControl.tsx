'use client';

/**
 * StatusControl — the Explorer's active / archived / expiring selector.
 *
 * Replaces the `archived` on/off button. Status is the one dimension a memory
 * always has EXACTLY ONE of, so it is a single-select over a closed set — which
 * is why it is not a filter pill: as a pill a user could construct "Status is
 * either of active, archived", which is "no filter" spelled at length.
 *
 * Rendered as the shared {@link Combobox} rather than a segmented button group.
 * Three visible segments spend toolbar width proportional to the number of
 * options, which is width the search box and the filter bar need more; and each
 * state carries a sentence of explanation ("live memories expiring within 7
 * days") that a segment has nowhere to put. A combobox shows the CURRENT state
 * and hides the alternatives until asked — the right trade for a control whose
 * value is read constantly and changed rarely — and it gets the mobile bottom
 * sheet, the keyboard model and the hint lines for free.
 *
 * All three states stay one click away: the trigger opens onto the current
 * value, so changing it is click-then-click, the same two interactions a
 * segmented group costs once the pointer has travelled.
 */

import { Combobox, type ComboboxItem } from '@/components/ui/Combobox';
import {
  MEMORY_STATUSES,
  STATUS_HINTS,
  STATUS_ICONS,
  STATUS_LABELS,
  type MemoryStatus,
} from '@/lib/status-filter';

/**
 * Built from the single source in `lib/status-filter.ts`, so a state added
 * there appears here with its label, its hint and its query mapping already
 * agreed — there is no second list to forget to update.
 */
const STATUS_OPTIONS: ComboboxItem<MemoryStatus>[] = MEMORY_STATUSES.map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
  // The hint is what the segmented control had no room for. "Expiring" alone
  // does not say over what horizon; here the answer is on the row.
  hint: STATUS_HINTS[status],
  icon: STATUS_ICONS[status],
}));

interface StatusControlProps {
  value: MemoryStatus;
  onChange: (status: MemoryStatus) => void;
  /**
   * `desktop` shows the icon and the label; `mobile` collapses to the icon,
   * matching how the rest of the toolbar responds. The accessible name carries
   * the label in both, so collapsing costs a sighted user width and a
   * screen-reader user nothing.
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
  return (
    <Combobox
      options={STATUS_OPTIONS}
      value={value}
      onChange={onChange}
      label="Status"
      compact={variant === 'mobile'}
      className={className}
    />
  );
}
