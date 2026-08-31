'use client';

/**
 * SegmentedControl — the ONE segmented button group, shared by every surface
 * that picks one value out of a small, closed, always-visible set.
 *
 * ## Why it exists
 *
 * The look already existed — inside `RangePicker`, as a private rail of
 * `role="radio"` buttons with an active segment lifted onto `--color-bg-raised`.
 * The moment a second surface needed the same control (the Lore Explorer's
 * Activity panel, choosing between its two bodies) the choice was to copy those
 * utilities or to extract them. Copying them is how two controls that must look
 * identical stop looking identical six months later, so this is the extraction:
 * `RangePicker` renders it, the Activity panel renders it, and a change to how a
 * segmented control looks lands once.
 *
 * ## Radios, not tabs
 *
 * `role="radiogroup"` / `role="radio"`, not `tablist`/`tab`. A tab OWNS the panel
 * it reveals and an assistive-tech user expects arrow-key navigation between tabs
 * plus a `tabpanel` relationship; a segmented control here is a *filter on what a
 * surface shows*, sometimes with nothing panel-shaped attached at all (the range
 * picker changes four numbers in place). Radio semantics say "one of these, and
 * this is the one" without promising a panel. The buttons stay individually
 * tabbable rather than implementing radio-group arrow keys, which is what the
 * pre-existing `RangePicker` did and what its tests pin.
 *
 * ## Not for every one-of-N choice
 *
 * Visible segments spend width in proportion to the number of options, and each
 * segment has nowhere to put an explanation. When either matters, use `Combobox`
 * instead — the Lore Explorer's Status selector (a pinned radiogroup inside
 * `FilterMenu`, `lib/status-filter.ts`) is the worked example of choosing a
 * combobox-style single-select deliberately over this control's fixed-width
 * segments, and that reasoning still stands even though its rendering has
 * since moved.
 */

import type { LucideIcon } from 'lucide-react';

export interface SegmentedControlItem<T extends string> {
  value: T;
  /** The visible text. Terse — these controls sit in dense rows. */
  label: string;
  /** Optional leading glyph. The only thing rendered when labels are hidden. */
  icon?: LucideIcon;
  /**
   * The accessible name, when it should differ from the visible label — which it
   * must whenever the label can be hidden ({@link SegmentedControlProps.labels}),
   * because an icon-only segment has no other name.
   */
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group for assistive tech. Required — an unnamed radiogroup is unusable. */
  label: string;
  items: readonly SegmentedControlItem<T>[];
  /**
   * The checked value, or `null` for "none of these" — which is a real state, not
   * a bug: `RangePicker` uses it when an absolute window matches no preset, and
   * fills the gap with a {@link SegmentedControlProps.trailing} arm.
   */
  value: T | null;
  onChange: (value: T) => void;
  /**
   * Whether the visible labels are shown.
   *
   * `'always'` (default) matches the original rail. `'wide'` hides them below the
   * `@md` CONTAINER width — the panel's own width, not the viewport's, so a
   * control inside a sidebar-squeezed panel or a narrow embed collapses to icons
   * for the same reason a phone does. Requires each item to carry an `ariaLabel`,
   * since the icon is then the segment's only visible content.
   */
  labels?: 'always' | 'wide';
  /**
   * An extra, non-radio arm rendered inside the same rail — for a surface that
   * needs to show a value the closed set cannot express. Kept inside the rail so
   * it reads as part of the control rather than as a chip floating beside it.
   */
  trailing?: React.ReactNode;
  className?: string;
}

/** The rail. Extracted verbatim from `RangePicker` so nothing moved on refactor. */
const RAIL =
  'flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5';

/**
 * A segment. `min-h-6` is the floor the original rail used; combined with the
 * rail's padding it clears the package's 24px hit-target accessibility floor.
 */
const SEGMENT =
  'inline-flex min-h-6 items-center justify-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium tabular-nums leading-none transition-colors duration-150';

/**
 * The checked segment. Lifted onto the RAISED surface inside an ELEVATED rail —
 * the selection reads as sitting on top of the group rather than being tinted,
 * which is what keeps it legible in a dark-only theme without spending the accent
 * colour on a control that is not the page's primary action.
 */
const SEGMENT_ACTIVE = 'bg-[var(--color-bg-raised)] text-[var(--color-content-primary)] shadow-sm';

const SEGMENT_IDLE =
  'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]';

export function SegmentedControl<T extends string>({
  label,
  items,
  value,
  onChange,
  labels = 'always',
  trailing,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={[RAIL, className].join(' ')}>
      {items.map((item) => {
        const isActive = value === item.value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={item.ariaLabel ?? item.label}
            onClick={() => onChange(item.value)}
            className={[SEGMENT, isActive ? SEGMENT_ACTIVE : SEGMENT_IDLE].join(' ')}
          >
            {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
            {/* Hidden with `hidden`/`@md:inline`, not with `sr-only`: the segment's
                accessible name comes from `aria-label`, so leaving a duplicate of
                the label in the tree for screen readers would announce it twice. */}
            <span className={labels === 'wide' ? 'hidden @md:inline' : undefined}>
              {item.label}
            </span>
          </button>
        );
      })}
      {trailing}
    </div>
  );
}

/**
 * The class list an out-of-set arm should wear to sit correctly in the rail.
 *
 * Exported rather than duplicated so a `trailing` arm cannot drift from the
 * checked segment it stands in for — `RangePicker`'s custom-window arm is a
 * `<span>` (it is inert), and it has to look exactly like a checked segment or
 * the control reads as having nothing selected.
 */
export const SEGMENTED_TRAILING_CLASS = [SEGMENT, SEGMENT_ACTIVE].join(' ');
