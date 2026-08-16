'use client';

/**
 * Combobox — the shared popup selection list, single- or multi-select.
 *
 * A trigger showing the current selection, and a popup list to change it. One
 * body rendered into two containers: an anchored popover at `md`+ and a
 * `BottomSheet` on the phone breakpoint, which is the repo-wide rule for
 * transient selection surfaces (see the root CLAUDE.md and `FilterMenu`, the
 * reference implementation). A popover assumes a mouse and a precise
 * click-outside, and can overflow a narrow screen; a sheet is the platform
 * shape.
 *
 * ## Single vs multiple
 *
 * `multiple` switches the control between the two shapes, and the props are a
 * discriminated union so the value and the change handler cannot disagree with
 * it: `multiple` takes `T[]` and hands back `T[]`, the default takes `T | null`
 * and hands back `T`. Two behaviours differ and nothing else does — picking a
 * row TOGGLES it instead of replacing the selection, and the list STAYS OPEN so
 * a second pick does not cost a second trip to the trigger. Dismissing is
 * therefore the explicit act (Escape, Tab, click-outside, or the sheet's
 * close), which is also how `FilterMenu` behaves.
 *
 * Multi-select was added rather than a second component so the phone shape,
 * the placement maths, the highlight/`aria-activedescendant` plumbing and the
 * search box stay written once — a `MultiCombobox` would have had to
 * re-implement the `isMobile` branch at the bottom of this file, and the two
 * copies would drift.
 *
 * ## Why this exists rather than a `<select>`
 *
 * A native select cannot carry a per-option icon or a second line of hint text,
 * and its popup is drawn by the OS, so it ignores the app's tokens entirely. It
 * is still the right answer for a long, plain list — reach for this one when
 * the options need explaining.
 *
 * ## ARIA
 *
 * The trigger is ALWAYS a `button` with `aria-haspopup="listbox"` — the correct
 * pattern for a select-like control, and deliberately NOT `role="combobox"` on
 * a non-editable element, which would promise an input that is not there. It
 * keeps `aria-haspopup` in both shapes: the trigger pops up a listbox either
 * way, so dropping the attribute when `searchable` only announced the control
 * as less than it is.
 *
 * `searchable` adds a text `combobox` INSIDE the popup — the search box, which
 * is the editable element that owns the listbox while it holds focus. Either
 * way the popup is a `listbox`, options are `option`s with `aria-selected`, and
 * the highlight travels by `aria-activedescendant` so DOM focus never leaves
 * whichever of the two the user is typing or arrowing in.
 *
 * The decisions worth testing without a browser — keyboard movement, filtering,
 * where the highlight opens — live in the pure `combobox.ts`.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { anchoredPosition, type AnchoredPosition } from '@/lib/anchored-position';
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  isSelected as isValueSelected,
  lastEnabledIndex,
  firstEnabledIndex,
  nextEnabledIndex,
  selectionSummary,
  toggleSelection,
  type ComboboxOption,
} from './combobox';

export type { ComboboxOption };

/** An option plus the presentational extras the pure model has no opinion about. */
export interface ComboboxItem<T extends string = string> extends ComboboxOption<T> {
  icon?: LucideIcon;
}

/** Everything both modes take. Exported so a wrapper can forward it verbatim. */
export interface ComboboxBaseProps<T extends string> {
  options: readonly ComboboxItem<T>[];
  /** Accessible name for the control. Also the sheet's title on mobile. */
  label: string;
  /**
   * Override the trigger's text.
   *
   * For the case below: with the value outside the option set there is no
   * option label to show, and falling back to the control's name ("Time range")
   * would hide the fact that a range is selected at all.
   */
  triggerLabel?: string;
  /** Show a search box above the list. Off by default — a short list does not need one. */
  searchable?: boolean;
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
  /** Extra classes on the trigger. */
  className?: string;
  /** Hide the trigger's text, leaving the icon — for a dense toolbar. */
  compact?: boolean;
}

interface ComboboxSingleProps<T extends string> extends ComboboxBaseProps<T> {
  multiple?: false;
  /**
   * The selected option, or `null` when the current value is not one of them.
   *
   * Nullable because a control's value can legitimately live outside its option
   * set: the Overview's range picker offers three presets, but the range can
   * also be an absolute window drilled in from a chart. Rendering that as "no
   * selection" is honest — none of the presets IS what the user is looking at —
   * and {@link ComboboxBaseProps.triggerLabel} is how the trigger still says
   * what it is.
   */
  value: T | null;
  onChange: (value: T) => void;
}

interface ComboboxMultiProps<T extends string> extends ComboboxBaseProps<T> {
  multiple: true;
  /** The selected options, empty when none. Never `null` — see `ComboboxSelection`. */
  value: readonly T[];
  /** Receives the WHOLE next selection, not the toggled member. */
  onChange: (values: T[]) => void;
  /**
   * Noun for the trigger's count past one selection ("3 scopes", "3 selected").
   * Plural — it is only ever reached with more than one.
   */
  countNoun?: string;
}

/**
 * Discriminated on `multiple` so `value`/`onChange` cannot disagree with the
 * mode: a `multiple` control with a scalar `value` is a type error, not a
 * runtime surprise.
 */
export type ComboboxProps<T extends string> = ComboboxSingleProps<T> | ComboboxMultiProps<T>;

/** Popover width in px. Narrower than the filter menu: these lists are short. */
const MENU_WIDTH = 240;
/** Non-list chrome: the search box when present, plus padding. */
const CHROME_WITH_SEARCH = 52;
const CHROME_WITHOUT_SEARCH = 8;

export function Combobox<T extends string>(props: ComboboxProps<T>) {
  const {
    options,
    value,
    label,
    triggerLabel,
    searchable = false,
    searchPlaceholder = 'Search…',
    className = '',
    compact = false,
  } = props;
  // Read off the union rather than destructured, so `props` stays narrowable in
  // `commit` — that is the one place the two modes actually diverge.
  const multiple = props.multiple === true;
  const isMobile = useIsMobile();
  const reduceMotion = useReducedMotion();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterOptions(options, query), [options, query]);
  // Only meaningful for the trigger's icon, which needs ONE option — an icon for
  // "3 selected" does not exist, so multi mode falls back to no icon past one.
  const selected = props.multiple
    ? props.value.length === 1
      ? options.find((o) => o.value === props.value[0])
      : undefined
    : options.find((o) => o.value === props.value);
  const selectionText = selectionSummary(
    options,
    value,
    props.multiple ? (props.countNoun ?? 'selected') : 'selected',
  );

  // ── open / close ───────────────────────────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    setQuery('');
    // Open ON the current value, so the list shows what you have rather than
    // making you find it.
    setHighlight(initialHighlight(options, value));
    setOpen(true);
  }, [options, value]);

  // Deliberately NOT `useCallback`: the only correct dependency is `props`,
  // which is a fresh object every render, so the memo would rebuild on every
  // render while reading as though it did not. Nothing downstream memoizes on
  // this — it is called from two plain event handlers — so a plain function is
  // both cheaper and honest about its lifetime.
  function commit(next: T) {
    if (props.multiple) {
      // Toggle and STAY OPEN: building a set of three is one trip to the
      // trigger, not three. The query survives too — narrowing to "repo::" and
      // ticking four of them is the whole point of a searchable multi-select.
      props.onChange(toggleSelection(props.value, next));
      return;
    }
    props.onChange(next);
    close();
  }

  // Typing narrows the list under the highlight, so re-home it or Enter selects
  // nothing and the control reads as broken.
  useEffect(() => {
    if (open) setHighlight((h) => clampHighlight(visible, h));
  }, [visible, open]);

  // Keep the highlighted row scrolled into view as the arrows walk past the
  // fold. The highlight travels by `aria-activedescendant`, so DOM focus never
  // moves and the browser never scrolls for us — on a list longer than the
  // 240px popover (or the sheet's band) keyboard navigation would otherwise
  // walk off-screen. `FilterMenu` does the same for the same reason.
  //
  // Indexed rather than queried by id: `useId()` emits colons, which are not
  // valid in a bare CSS id selector, and the rendered order is `visible`'s
  // order — disabled options are rendered too, so the indices line up.
  useEffect(() => {
    if (!open || highlight < 0) return;
    listRef.current?.querySelectorAll('[role="option"]')[highlight]?.scrollIntoView({
      block: 'nearest',
    });
  }, [highlight, open, visible]);

  // ── placement (desktop only) ───────────────────────────────────────────────
  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPosition(
      anchoredPosition(
        trigger.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        {
          width: MENU_WIDTH,
          chromeHeight: searchable ? CHROME_WITH_SEARCH : CHROME_WITHOUT_SEARCH,
        },
      ),
    );
  }, [searchable]);

  // Measured BEFORE paint: an unmeasured popover renders `visibility: hidden`,
  // and a hidden element silently refuses focus — the search box would never
  // receive it and every keystroke would go to the document. Same trap
  // `FilterMenu` documents.
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    measure();
    // `capture: true` because scroll does not bubble and the trigger's scrolling
    // ancestor is usually a panel, not the window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, isMobile, measure]);

  // Focus the search box once the popover is real and measured.
  useEffect(() => {
    if (open && !isMobile && searchable && position) searchRef.current?.focus();
  }, [open, isMobile, searchable, position]);

  // ── click-outside (desktop) ────────────────────────────────────────────────
  useEffect(() => {
    if (!open || isMobile) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      // BOTH refs: the popover is portaled out of the trigger's subtree, so a
      // click on one of its own rows is "outside" the container element.
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, isMobile]);

  // ── keyboard ───────────────────────────────────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlight((h) => nextEnabledIndex(visible, h, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlight((h) => nextEnabledIndex(visible, h, -1));
        break;
      case 'Home':
        e.preventDefault();
        setHighlight(firstEnabledIndex(visible));
        break;
      case 'End':
        e.preventDefault();
        setHighlight(lastEnabledIndex(visible));
        break;
      // Space is a second activation key for the highlighted row, but ONLY
      // without a search box — there it is a literal space in the query, and
      // hijacking it makes multi-word searches impossible to type.
      case ' ':
        if (searchable) break;
      // eslint-disable-next-line no-fallthrough
      case 'Enter': {
        e.preventDefault();
        const option = visible[highlight];
        // `commit` decides what activation MEANS: replace-and-close in single
        // mode, toggle-and-stay in multi.
        if (option && !option.disabled) commit(option.value);
        break;
      }
      case 'Escape':
        e.preventDefault();
        // `stopPropagation` so Escape does not ALSO close a dialog or detail
        // sheet behind the menu — one Escape, one dismissal.
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        // Tabbing away commits nothing and closes: the selection is the click,
        // not the highlight.
        setOpen(false);
        setQuery('');
        break;
      default:
        break;
    }
  }

  // ── the shared body ────────────────────────────────────────────────────────
  const list = (
    <>
      {searchable && (
        <div className="relative border-b border-[var(--color-border)] p-2">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            // Here as well as on the trigger, not instead of it: this input is
            // what holds DOM focus while `searchable`, and a screen reader
            // announces `aria-activedescendant` from the FOCUSED element only.
            // Left on the trigger alone, the highlight moved silently for
            // exactly the shape that has a highlight worth announcing.
            aria-activedescendant={highlight >= 0 ? `${baseId}-option-${highlight}` : undefined}
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="min-h-9 w-full rounded-md bg-transparent pl-7 pr-2 text-sm text-[var(--color-content-primary)] outline-none placeholder:text-[var(--color-content-tertiary)]"
          />
        </div>
      )}
      {/* A `div`, not a `ul`: every child of a listbox must be an option, and a
          `ul` forces an `li` wrapper around each one that the accessibility
          tree then has to see through. `FilterMenu` renders its options as
          direct children of its listbox for the same reason. */}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={label}
        // Announced only in the shape that has it. A single-select listbox
        // carrying `aria-multiselectable="false"` reads as a control that COULD
        // take several and does not, which is noise.
        {...(multiple ? { 'aria-multiselectable': true } : {})}
        className="max-h-full overflow-y-auto p-1"
      >
        {visible.length === 0 && (
          <p role="presentation" className="px-3 py-2 text-xs text-[var(--color-content-tertiary)]">
            No matches
          </p>
        )}
        {visible.map((option, i) => {
          const Icon = option.icon;
          const isSelected = isValueSelected(value, option.value);
          return (
            <button
              key={option.value}
              type="button"
              id={`${baseId}-option-${i}`}
              role="option"
              aria-selected={isSelected}
              aria-disabled={option.disabled}
              disabled={option.disabled}
              // Pointer, not click: the click-outside handler runs on
              // pointerdown, so a click listener would fire after the menu
              // had already begun closing on some browsers.
              onPointerUp={() => !option.disabled && commit(option.value)}
              // Keep DOM focus OFF the row. The control's whole keyboard model
              // is that focus stays on the trigger (or the search box) and the
              // highlight travels by `aria-activedescendant`; a row that takes
              // focus on mousedown breaks it, because `onKeyDown` is bound to
              // those two elements and nothing else. Single-select hid the bug
              // — the list closed on the pick, so there was no "after a mouse
              // pick" to press Escape in. Multi-select keeps the list open, and
              // there Escape and Tab silently stopped dismissing.
              //
              // `mousedown` rather than `pointerdown`: focus is a default
              // action of the compatibility mouse event, and suppressing it
              // there leaves `pointerup` — which is what commits — untouched.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => !option.disabled && setHighlight(i)}
              className={[
                'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors duration-100',
                option.disabled
                  ? 'cursor-not-allowed text-[var(--color-content-tertiary)] opacity-50'
                  : i === highlight
                    ? 'bg-[var(--color-bg-elevated)] text-[var(--color-content-primary)]'
                    : 'text-[var(--color-content-secondary)]',
              ].join(' ')}
            >
              {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{option.label}</span>
                {option.hint && (
                  <span className="truncate text-[10px] text-[var(--color-content-tertiary)]">
                    {option.hint}
                  </span>
                )}
              </span>
              {/* Multi-select reserves the slot whether or not the row is
                  ticked: the label must not shift sideways as you tick down a
                  list, which is the one thing that makes a multi-select feel
                  unsteady. Single-select never shows two ticks at once, so it
                  has nothing to keep aligned and renders the tick only. */}
              {multiple ? (
                <Check
                  className={[
                    'size-4 shrink-0 text-[var(--color-accent)]',
                    isSelected ? '' : 'invisible',
                  ].join(' ')}
                  aria-hidden
                />
              ) : (
                isSelected && (
                  <Check className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
                )
              )}
            </button>
          );
        })}
      </div>
    </>
  );

  const TriggerIcon = selected?.icon;
  // The override wins, then the selection (one label, or a count past one), then
  // the control's own name — which is only reached when nothing is selected and
  // no override was given.
  const triggerText = triggerLabel ?? selectionText ?? label;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Not `role="combobox"`: the trigger is never editable, and promising
        // an input that is not there is worse than the plain button pattern.
        // `searchable` puts the real `combobox` on the search box inside the
        // popup, which does not change what THIS control does — it pops up a
        // listbox in both shapes, so it advertises that in both shapes.
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && highlight >= 0 ? `${baseId}-option-${highlight}` : undefined}
        aria-label={`${label}: ${triggerLabel ?? selectionText ?? 'none'}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={[
          'flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:text-[var(--color-content-primary)]',
          className,
        ].join(' ')}
      >
        {TriggerIcon && <TriggerIcon className="size-3.5 shrink-0" aria-hidden />}
        {!compact && <span className="truncate">{triggerText}</span>}
        <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
      </button>

      {isMobile ? (
        <BottomSheet open={open} onClose={close} title={label}>
          {/* Bounded so navigating a long list changes content, not layout: a
              sheet is anchored to the bottom edge, so a height change moves
              every row under the user's thumb mid-gesture. */}
          <div className="flex max-h-[55vh] min-h-[30vh] flex-col">{list}</div>
        </BottomSheet>
      ) : (
        typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={popoverRef}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{
                  position: 'fixed',
                  width: MENU_WIDTH,
                  left: position?.left ?? 0,
                  ...(position?.top !== undefined ? { top: position.top } : {}),
                  ...(position?.bottom !== undefined ? { bottom: position.bottom } : {}),
                  // Hidden until measured — see the layout-effect note above.
                  visibility: position ? 'visible' : 'hidden',
                  zIndex: 60,
                }}
                className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-lg"
              >
                <div style={{ maxHeight: position?.listMaxHeight }} className="flex flex-col">
                  {list}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )
      )}
    </>
  );
}
