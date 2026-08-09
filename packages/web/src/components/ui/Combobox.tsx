'use client';

/**
 * Combobox — the shared single-select popup list.
 *
 * A trigger showing the current selection, and a popup list to change it. One
 * body rendered into two containers: an anchored popover at `md`+ and a
 * `BottomSheet` on the phone breakpoint, which is the repo-wide rule for
 * transient selection surfaces (see the root CLAUDE.md and `FilterMenu`, the
 * reference implementation). A popover assumes a mouse and a precise
 * click-outside, and can overflow a narrow screen; a sheet is the platform
 * shape.
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
 * With `searchable`, the trigger is a text `combobox` owning a `listbox`. Without
 * it there is nothing to type into, so the trigger is a `button` with
 * `aria-haspopup="listbox"` — the correct pattern for a select-like control, and
 * deliberately NOT `role="combobox"` on a non-editable element, which would
 * promise an input that is not there. Either way the popup is a `listbox`,
 * options are `option`s with `aria-selected`, and the highlight travels by
 * `aria-activedescendant` so DOM focus never leaves the trigger.
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
  lastEnabledIndex,
  firstEnabledIndex,
  nextEnabledIndex,
  type ComboboxOption,
} from './combobox';

export type { ComboboxOption };

/** An option plus the presentational extras the pure model has no opinion about. */
export interface ComboboxItem<T extends string = string> extends ComboboxOption<T> {
  icon?: LucideIcon;
}

interface ComboboxProps<T extends string> {
  options: readonly ComboboxItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the control. Also the sheet's title on mobile. */
  label: string;
  /** Show a search box above the list. Off by default — a short list does not need one. */
  searchable?: boolean;
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
  /** Extra classes on the trigger. */
  className?: string;
  /** Hide the trigger's text, leaving the icon — for a dense toolbar. */
  compact?: boolean;
}

/** Popover width in px. Narrower than the filter menu: these lists are short. */
const MENU_WIDTH = 240;
/** Non-list chrome: the search box when present, plus padding. */
const CHROME_WITH_SEARCH = 52;
const CHROME_WITHOUT_SEARCH = 8;

export function Combobox<T extends string>({
  options,
  value,
  onChange,
  label,
  searchable = false,
  searchPlaceholder = 'Search…',
  className = '',
  compact = false,
}: ComboboxProps<T>) {
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

  const visible = useMemo(() => filterOptions(options, query), [options, query]);
  const selected = options.find((o) => o.value === value);

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

  const commit = useCallback(
    (next: T) => {
      onChange(next);
      close();
    },
    [onChange, close],
  );

  // Typing narrows the list under the highlight, so re-home it or Enter selects
  // nothing and the control reads as broken.
  useEffect(() => {
    if (open) setHighlight((h) => clampHighlight(visible, h));
  }, [visible, open]);

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
      case 'Enter': {
        e.preventDefault();
        const option = visible[highlight];
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
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="min-h-9 w-full rounded-md bg-transparent pl-7 pr-2 text-sm text-[var(--color-content-primary)] outline-none placeholder:text-[var(--color-content-tertiary)]"
          />
        </div>
      )}
      <ul
        id={listboxId}
        role="listbox"
        aria-label={label}
        className="max-h-full overflow-y-auto p-1"
      >
        {visible.length === 0 && (
          <li className="px-3 py-2 text-xs text-[var(--color-content-tertiary)]">No matches</li>
        )}
        {visible.map((option, i) => {
          const Icon = option.icon;
          const isSelected = option.value === value;
          return (
            <li key={option.value}>
              <button
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
                {isSelected && (
                  <Check className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );

  const TriggerIcon = selected?.icon;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Not `role="combobox"`: without a search box there is nothing to type
        // into, and promising an input that is not there is worse than the
        // plain button pattern.
        {...(searchable ? {} : { 'aria-haspopup': 'listbox' as const })}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && highlight >= 0 ? `${baseId}-option-${highlight}` : undefined}
        aria-label={`${label}: ${selected?.label ?? 'none'}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={[
          'flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:text-[var(--color-content-primary)]',
          className,
        ].join(' ')}
      >
        {TriggerIcon && <TriggerIcon className="size-3.5 shrink-0" aria-hidden />}
        {!compact && <span className="truncate">{selected?.label ?? label}</span>}
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
