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
 *
 * ## The rail is now shared
 *
 * The bordered rail, the segment sizing and the lifted active segment used to be
 * private utility strings here. They are {@link SegmentedControl} now, because a
 * second surface (the Explorer's Activity panel view toggle) needed the same
 * control and two copies of a look that must match is how it stops matching. The
 * ONE thing this picker has that a generic segmented control does not — the inert
 * custom-window arm below — goes in through its `trailing` slot, so the rendered
 * rail is unchanged.
 */

import {
  SEGMENTED_TRAILING_CLASS,
  SegmentedControl,
  type SegmentedControlItem,
} from '@/components/ui/SegmentedControl';
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
  /**
   * The control's accessible name. Defaults to the generic `'Time range'`,
   * which is right for a page with ONE picker — but Insights has two
   * independent windows (agent activity, scope consumption), and two
   * radiogroups both named "Time range" leave a screen-reader user with no way
   * to tell which range they are about to change. Name them there.
   */
  label?: string;
  className?: string;
}

export function RangePicker({
  value,
  onChange,
  presets,
  nowIso,
  label = 'Time range',
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

  const items: SegmentedControlItem<RangePreset>[] = presets.map((preset) => ({
    value: preset,
    label: PRESET_LABELS[preset],
    ariaLabel: preset === 'all' ? 'All time' : `Last ${PRESET_LABELS[preset]}`,
  }));

  return (
    <SegmentedControl
      label={label}
      items={items}
      value={selected}
      // `all` emits `{preset:'all'}`, NOT `null`. Both resolve to an unbounded
      // window (`resolveRange`), so nothing downstream can tell them apart — but
      // a CALLER can, and the Explorer needs to: an absent `?range=` is "the
      // reader has not chosen yet" (its Activity panel substitutes a 24h display
      // default), while an explicit `All` is a choice that must survive as one.
      // Emitting `null` here made the two states the same value and the choice
      // unexpressible.
      onChange={(preset) => onChange({ preset })}
      className={className}
      trailing={
        // A custom window gets its own segment rather than leaving the control
        // looking unset. It is ACTIVE and inert: clicking a preset is how you
        // leave it, so there is no extra concept to learn and no dead control —
        // and without it, drilling into an hour from a chart would silently
        // deselect everything and read as a bug. It is a CHECKED radio, not a
        // bare span: this arm is what the radiogroup has selected, so a screen
        // reader that found no checked preset must find the selection here
        // instead of reporting the whole group unset. `aria-disabled` says it
        // is inert without removing it from the group's checked count.
        selected === null ? (
          <span
            role="radio"
            aria-checked={true}
            aria-disabled={true}
            // Focusable even though it is inert: it is the group's CHECKED arm, and
            // the preset arms are native buttons, so without this the one selected
            // item is the one a keyboard user cannot reach. `aria-disabled` (not the
            // `disabled` attribute, which a span can't take anyway) keeps it in the
            // tab order while marking it inactive — you leave it by focusing a preset.
            tabIndex={0}
            aria-label={`Custom range — ${rangeLabel(value, nowIso)}`}
            className={SEGMENTED_TRAILING_CLASS}
            title="Custom range — pick a preset to leave it"
          >
            {rangeLabel(value, nowIso)}
          </span>
        ) : null
      }
    />
  );
}
