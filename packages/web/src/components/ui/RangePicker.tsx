'use client';

/**
 * RangePicker — the ONE time-range control, shared by the Overview and the
 * Explorer.
 *
 * The two pages read the same `range` param (`lib/time-range.ts`) but had
 * grown only one control between them: the Overview's, private to
 * `DashboardStats`. So the Explorer had no way to say "last 24 hours" at all —
 * its only range affordances were a calendar and a heatmap click, both of which
 * express a WINDOW when what a reader usually wants is a HORIZON.
 *
 * Sharing the component rather than copying its markup is what makes the two
 * pages stay consistent: a change to how a range is picked lands in one place
 * and both surfaces move together. That is the difference between consistent
 * today and consistent in six months.
 *
 * ## Presets are per-surface, and that is not an inconsistency
 *
 * The Overview omits `all`: every card there shows a period-over-period change,
 * which needs a PRECEDING window of equal length, and "all time" has none. The
 * Explorer offers it, because a list has no such requirement and browsing
 * everything is the thing people come to the Explorer to do. Same control, same
 * vocabulary, different menu — which is a property of the question each page
 * asks, not a drift.
 */

import { isPresetRange, rangeLabel, type RangePreset, type TimeRange } from '@/lib/time-range';

/** The label on each segment. Terse, because the control sits in a dense row. */
const PRESET_LABELS: Record<RangePreset, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All',
};

interface RangePickerProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  /** Which presets this surface offers, in display order. */
  presets: readonly RangePreset[];
  /** Injected so a custom window's label describes the same instant the page does. */
  nowIso: string;
  className?: string;
}

export function RangePicker({
  value,
  onChange,
  presets,
  nowIso,
  className = '',
}: RangePickerProps) {
  // `null` for the ABSOLUTE arm — a window drilled in from the heatmap or
  // arriving in a deep link matches no preset, which is the honest reading:
  // none of them IS what the user is looking at.
  const active = isPresetRange(value) ? value.preset : null;
  // `range === null` means unbounded, which IS the `all` preset semantically.
  const resolved = active ?? (value === null ? 'all' : null);
  // …but only if THIS surface offers that preset. The Overview omits `all`, so a
  // shared `?range=null` link resolving to `all` would check no radio here; fall
  // back to the custom-window chip instead of leaving the control looking unset.
  const selected = resolved && presets.includes(resolved) ? resolved : null;

  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className={[
        'flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5',
        className,
      ].join(' ')}
    >
      {presets.map((preset) => {
        const isActive = selected === preset;
        return (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={preset === 'all' ? 'All time' : `Last ${PRESET_LABELS[preset]}`}
            onClick={() => onChange(preset === 'all' ? null : { preset })}
            className={[
              'min-h-6 rounded px-2 py-0.5 text-[10px] font-medium tabular-nums transition-colors duration-150',
              isActive
                ? 'bg-[var(--color-bg-raised)] text-[var(--color-content-primary)] shadow-sm'
                : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
            ].join(' ')}
          >
            {PRESET_LABELS[preset]}
          </button>
        );
      })}

      {/* A custom window gets its own segment rather than leaving the control
          looking unset. It is ACTIVE and inert: clicking a preset is how you
          leave it, so there is no extra concept to learn and no dead control —
          and without it, drilling into an hour from a chart would silently
          deselect everything and read as a bug. */}
      {selected === null && (
        <span
          className="min-h-6 rounded bg-[var(--color-bg-raised)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-content-primary)] shadow-sm"
          title="Custom range — pick a preset to leave it"
        >
          {rangeLabel(value, nowIso)}
        </span>
      )}
    </div>
  );
}
