'use client';

/**
 * LabelFilter
 *
 * Searchable multi-select for the Lore Explorer's label (`memories.tags`)
 * filter. Sits in the filter row beside the date picker and the archived
 * toggle, and matches their trigger shape exactly (`min-h-9`, `rounded-lg`,
 * `px-2.5`, `text-xs`) so the row reads as one set of controls.
 *
 * ## Why a popover and not a chip row
 * An always-expanded chip bar costs vertical space proportional to how many
 * labels an account has — the one thing that grows without bound here — and
 * pushes the results it exists to filter below the fold. Collapsing it behind
 * one trigger makes the cost constant, and the search box turns "scan 60 chips"
 * into "type three characters", which is the faster path the moment a user has
 * more labels than fit on a line.
 *
 * ## Interaction (mirrors DateRangePicker — see /animations "popover")
 * Trigger toggles a popover that fades + scales from its anchor; click-outside
 * and Escape close it; reduced motion collapses the animation to a fade.
 *
 * ## Keyboard
 * Focus stays in the search input while ArrowUp/ArrowDown move a virtual
 * "active option" (`aria-activedescendant`) — the WAI-ARIA combobox pattern —
 * so a user can type, arrow, and Enter-toggle without ever leaving the field.
 * Enter toggles the active option and keeps the popover open, because
 * multi-select means the next pick is more likely than not. Escape closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Check, Search, Tag, X } from 'lucide-react';
import { searchTags, tagOptions, tagTriggerLabel, type TagCount } from '@/lib/tag-filter';

interface LabelFilterProps {
  /** Label catalog for the partition in view, with counts. */
  catalog: TagCount[];
  /** Currently selected labels. */
  selected: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
  /**
   * `desktop` shows the summary text in the trigger; `mobile` is icon-only with
   * a count badge, matching the archived toggle's behaviour in the same row.
   */
  variant: 'desktop' | 'mobile';
  className?: string;
}

const LISTBOX_ID = 'label-filter-listbox';
const OPTION_ID_PREFIX = 'label-filter-option-';

export function LabelFilter({
  catalog,
  selected,
  onToggle,
  onClear,
  variant,
  className = '',
}: LabelFilterProps) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => tagOptions(catalog, selected), [catalog, selected]);
  const matches = useMemo(() => searchTags(options, query), [options, query]);

  // Keep the active option inside the (possibly shrinking) match list.
  useEffect(() => {
    setActiveIndex((i) => (matches.length === 0 ? 0 : Math.min(i, matches.length - 1)));
  }, [matches.length]);

  // Close on click-outside.
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  // Focus the search box on open; reset the query on close so the next open
  // starts from the full list rather than a stale filter.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  // Keep the active option scrolled into view as the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`#${OPTION_ID_PREFIX}${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const active = matches[activeIndex];
      // Multi-select: toggling keeps the popover open so the next pick does not
      // cost another round trip through the trigger.
      if (active) onToggle(active.tag);
    }
  }

  const desktop = variant === 'desktop';
  const summary = tagTriggerLabel(selected);
  const active = selected.length > 0;
  const triggerDescription = active
    ? `Filtering by ${selected.length} label${selected.length === 1 ? '' : 's'}: ${selected.join(', ')}`
    : 'Filter by label';

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={triggerDescription}
        title={desktop ? triggerDescription : undefined}
        className={[
          'flex min-h-9 shrink-0 items-center rounded-lg border transition-colors duration-150',
          desktop ? 'gap-1.5 px-2.5 py-1.5 text-xs font-medium' : 'gap-1 px-2 py-2',
          active
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
        ].join(' ')}
      >
        <Tag className={desktop ? 'size-3.5 shrink-0' : 'size-4 shrink-0'} aria-hidden />
        {desktop ? (
          <span className="max-w-32 truncate">{summary}</span>
        ) : (
          active && <span className="text-xs font-medium tabular-nums">{selected.length}</span>
        )}
        {active && desktop && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear label filter"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                onClear();
              }
            }}
            className="-mr-1 ml-0.5 flex size-4 items-center justify-center rounded-full hover:bg-[var(--color-bg-elevated)]"
          >
            <X className="size-3" aria-hidden />
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Filter by label"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-full z-40 mt-1.5 w-64 origin-top-right overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-lg"
          >
            {/* Search */}
            <div className="relative border-b border-[var(--color-border)] p-2">
              <Search
                className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]"
                aria-hidden
              />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={LISTBOX_ID}
                aria-autocomplete="list"
                aria-activedescendant={
                  matches.length > 0 ? `${OPTION_ID_PREFIX}${activeIndex}` : undefined
                }
                aria-label="Search labels"
                placeholder="Search labels…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>

            {/* Options */}
            <div
              ref={listRef}
              id={LISTBOX_ID}
              role="listbox"
              aria-multiselectable
              aria-label="Labels"
              className="max-h-56 overflow-y-auto p-1"
            >
              {matches.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-[var(--color-content-tertiary)]">
                  {options.length === 0
                    ? 'No labels yet — memories pick these up from their tags.'
                    : `No label matches “${query.trim()}”.`}
                </p>
              ) : (
                matches.map((option, i) => {
                  const isSelected = selected.includes(option.tag);
                  return (
                    <button
                      key={option.tag}
                      id={`${OPTION_ID_PREFIX}${i}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => onToggle(option.tag)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={[
                        'flex w-full min-h-8 items-center gap-2 rounded-md px-2 text-left text-xs transition-colors duration-100',
                        i === activeIndex ? 'bg-[var(--color-bg-elevated)]' : '',
                        isSelected
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-content-secondary)]',
                      ].join(' ')}
                    >
                      <span
                        aria-hidden
                        className={[
                          'flex size-3.5 shrink-0 items-center justify-center rounded border',
                          isSelected
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]'
                            : 'border-[var(--color-border)]',
                        ].join(' ')}
                      >
                        {isSelected && <Check className="size-2.5" />}
                      </span>
                      <span className="flex-1 truncate">{option.tag}</span>
                      {option.count !== null && (
                        <span className="shrink-0 tabular-nums text-[var(--color-content-tertiary)]">
                          {option.count}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer: states the combining rule, and clears in one click.
                The AND rule lives here rather than only in a tooltip because
                "why did my second label empty the list?" is the question this
                control has to answer before it is asked. */}
            <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-2 py-1.5">
              <p className="text-[10px] leading-tight text-[var(--color-content-tertiary)]">
                {active ? 'Shows memories with every selected label' : 'Pick one or more labels'}
              </p>
              {active && (
                <button
                  type="button"
                  onClick={onClear}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-content-secondary)] transition-colors hover:text-[var(--color-content-primary)]"
                >
                  Clear
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
