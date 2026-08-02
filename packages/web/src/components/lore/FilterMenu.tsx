'use client';

/**
 * FilterMenu
 *
 * The Lore Explorer's filter command menu: a **two-level** combobox that picks
 * a dimension (Label, Agent, Trigger, Repository, Branch, Pull request) and
 * then values within it. It replaces `LabelFilter`, which could only ever
 * address one dimension.
 *
 * ## Why one menu and not six pickers
 * The filter row already holds a search box, a date picker and an archived
 * toggle. Adding a trigger per dimension would put nine controls on a line that
 * has to survive a phone, and it would still not answer "what CAN I filter by?"
 * for the seventh dimension. One trigger keeps the cost of a new dimension at
 * one row in a list, and the list is itself the answer to that question.
 *
 * ## Interaction (Linear's model)
 * Level 1 is the dimension list; choosing one pushes to level 2, its value
 * list. Crucially, typing at level 1 searches BOTH — type `main` and
 * `Branch → main` appears without ever choosing "Branch", so the two-level
 * structure costs the expert nothing. `rootSuggestions` owns that ranking.
 *
 * ## Keyboard
 * DOM focus never leaves the search input for the popover's whole life; arrows
 * move a virtual active option (`aria-activedescendant`), the WAI-ARIA combobox
 * pattern `LabelFilter` already used. On top of that:
 *
 * | Key | Level 1 | Level 2 |
 * |---|---|---|
 * | `↑` / `↓` | move active row | move active row |
 * | `→` | drill into the active dimension | — (caret) |
 * | `←` | — (caret) | back, when the caret is at position 0 |
 * | `Enter` | drill in, or commit a `Dimension → value` row and close | toggle and CLOSE |
 * | `Space` | — (types a space) | toggle and STAY OPEN, when the query is empty |
 * | `Backspace` | — | back, when the query is empty |
 * | `Escape` | clear the query, else close | clear the query, else back, else close |
 *
 * `Space` toggles and `Enter` commits-and-closes because multi-select and
 * "I am done" are different intents and deserve different keys — the previous
 * control overloaded Enter with both and left no way to say "done" without
 * reaching for Escape or the mouse. Space is bound only while the query is
 * empty: a value may contain a space, and swallowing the space bar inside a
 * text field is the worse surprise.
 *
 * Every toggle applies immediately — there is no Apply button. The result list
 * behind the menu updates as you go, which is what makes "toggle three, then
 * Enter" a decision rather than a leap.
 *
 * ## Motion (see /animations "popover")
 * The popover fades + scales from its anchor exactly as `DateRangePicker` and
 * the old `LabelFilter` do, so the row's three controls feel like one set. The
 * level transition is a short slide + fade in the direction of travel, and the
 * container's height is animated to the incoming level's — the one transition
 * here that carries information, because it says "same surface, new contents"
 * rather than "a second popover". The active-row highlight is deliberately NOT
 * animated: it moves on every arrow press, and tweening it directly slows
 * keyboard throughput. Reduced motion collapses all of it to a fade.
 *
 * On the phone breakpoint (`variant="mobile"`) the same body opens in the
 * shared `BottomSheet` instead, per the repo-wide rule for transient selection
 * surfaces.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  ListFilter,
  Search,
  Tag,
  Zap,
  FolderGit2,
  type LucideIcon,
} from 'lucide-react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import {
  FILTER_FIELDS,
  facetOptions,
  requireField,
  rootSuggestions,
  searchOptions,
  selectedValues,
  type FacetValue,
  type Filter,
  type FilterField,
} from '@/lib/filters';

/** One icon per dimension, so a row is recognisable before it is read. */
export const FIELD_ICONS: Record<FilterField, LucideIcon> = {
  label: Tag,
  agent: Bot,
  trigger: Zap,
  repo: FolderGit2,
  branch: GitBranch,
  pr: GitPullRequest,
};

const LISTBOX_ID = 'filter-menu-listbox';
const OPTION_ID_PREFIX = 'filter-menu-option-';

interface FilterMenuProps {
  /** Every filterable value with its count, from `GET /memories/facets`. */
  facets: FacetValue[];
  /** The committed filter bar — drives which value rows read as selected. */
  filters: Filter[];
  onToggleValue: (field: FilterField, value: string) => void;
  /**
   * `desktop` anchors a popover and labels the trigger; `mobile` opens the same
   * body in a `BottomSheet` and shows an icon with a count badge, matching the
   * archived toggle beside it.
   */
  variant: 'desktop' | 'mobile';
  /**
   * Open the menu straight at a dimension's value list. Set by a pill's value
   * segment: the user came in at depth 1, so "back" from there means closed,
   * not "the dimension list" — see {@link entryDepth}.
   */
  openAtField?: FilterField | null;
  /** Cleared by the menu when it closes, so the pill's request is not sticky. */
  onOpenAtFieldHandled?: () => void;
  className?: string;
}

export function FilterMenu({
  facets,
  filters,
  onToggleValue,
  variant,
  openAtField = null,
  onOpenAtFieldHandled,
  className = '',
}: FilterMenuProps) {
  const reduceMotion = useReducedMotion();
  const useSheet = variant === 'mobile';
  const desktop = variant === 'desktop';

  const [open, setOpen] = useState(false);
  /** `null` = the dimension list (level 1); a field = its value list (level 2). */
  const [field, setField] = useState<FilterField | null>(null);
  /**
   * The level the menu was opened at. Escape/Backspace pop back to it and no
   * further: a menu opened on a pill's value segment closes rather than
   * revealing a dimension list the user never asked for.
   */
  const [entryDepth, setEntryDepth] = useState(0);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A pill's value segment asks for the menu at level 2 of one dimension.
  useEffect(() => {
    if (!openAtField) return;
    setField(openAtField);
    setEntryDepth(1);
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
    onOpenAtFieldHandled?.();
  }, [openAtField, onOpenAtFieldHandled]);

  // ── Rows for the current level ─────────────────────────────────────────────

  const rootRows = useMemo(() => rootSuggestions(facets, query), [facets, query]);

  const valueRows = useMemo(() => {
    if (!field) return [];
    return searchOptions(facetOptions(facets, field, selectedValues(filters, field)), query);
  }, [facets, field, filters, query]);

  const rowCount = field ? valueRows.length : rootRows.length;

  // Keep the active row inside the (possibly shrinking) list.
  useEffect(() => {
    setActiveIndex((i) => (rowCount === 0 ? 0 : Math.min(i, rowCount - 1)));
  }, [rowCount]);

  // Keep the active row scrolled into view as the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`#${OPTION_ID_PREFIX}${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  // Focus the search box on open — popover only. Auto-focusing inside the sheet
  // would raise the on-screen keyboard over the options before the user has
  // asked to type; they tap the field when ready.
  useEffect(() => {
    if (open) {
      if (!useSheet) inputRef.current?.focus();
    } else {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open, useSheet]);

  // Close on click-outside — popover only. The sheet owns its own dismissal and
  // portals outside `containerRef`, so a tap inside it would read as "outside".
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);
  useEffect(() => {
    if (!open || useSheet) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, useSheet, handleClickOutside]);

  // ── Navigation ─────────────────────────────────────────────────────────────

  function openMenu() {
    setField(null);
    setEntryDepth(0);
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
  }

  function pushField(next: FilterField) {
    setField(next);
    // Clearing the query on push is what makes the dimension list searchable
    // AND the value list searchable with one box: the query that found the
    // dimension is meaningless against its values.
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }

  /** Back one level, or close when already at the level the menu opened on. */
  function popLevel() {
    if (field === null || entryDepth === 1) {
      closeMenu();
      return;
    }
    setField(null);
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }

  function commitRootRow(index: number) {
    const row = rootRows[index];
    if (!row) return;
    if (row.kind === 'field') {
      pushField(row.field);
      return;
    }
    // A `Dimension → value` row is a whole condition in one keystroke.
    onToggleValue(row.field, row.value);
    closeMenu();
  }

  function toggleValueRow(index: number, { close }: { close: boolean }) {
    const row = valueRows[index];
    if (!row || !field) return;
    onToggleValue(field, row.value);
    if (close) closeMenu();
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const caretAtStart =
      e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i + 1) % rowCount));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i - 1 + rowCount) % rowCount));
      return;
    }
    if (e.key === 'ArrowRight' && field === null) {
      // Only when the caret is at the end, so Right still moves through text
      // the user is editing.
      const atEnd = e.currentTarget.selectionStart === query.length;
      if (!atEnd) return;
      const row = rootRows[activeIndex];
      if (row?.kind === 'field') {
        e.preventDefault();
        pushField(row.field);
      }
      return;
    }
    if (e.key === 'ArrowLeft' && field !== null && caretAtStart) {
      e.preventDefault();
      popLevel();
      return;
    }
    if (e.key === 'Backspace' && field !== null && query === '') {
      e.preventDefault();
      popLevel();
      return;
    }
    if (e.key === ' ' && field !== null && query === '') {
      // Toggle without leaving: the next pick is more likely than not.
      e.preventDefault();
      toggleValueRow(activeIndex, { close: false });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (field === null) commitRootRow(activeIndex);
      else toggleValueRow(activeIndex, { close: true });
    }
  }

  /**
   * Escape, handled on the container in the bubble phase rather than on the
   * document, so `stopPropagation` keeps the SAME Escape from also reaching
   * `LessonDetailSheet`'s document listener and closing an open lesson behind
   * the menu. Handling it here (not on the input) also covers the case where a
   * click has moved focus onto an option button.
   *
   * Staged, matching how the app's other search surfaces behave: a non-empty
   * query is cleared first (the results stay), then the level is popped, then
   * the menu closes. Escape is "back", never "cancel" — values already toggled
   * are already applied and are not rolled back.
   */
  function handleContainerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape' || !open || useSheet) return;
    e.stopPropagation();
    if (query !== '') {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
      return;
    }
    popLevel();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  const descriptor = field ? requireField(field) : null;
  const activeCount = filters.length;
  const triggerDescription =
    activeCount > 0
      ? `Filters: ${activeCount} applied. Add or edit a filter`
      : 'Add filter';

  const listMaxH = useSheet ? 'max-h-[55vh]' : 'max-h-64';

  const emptyCopy = field
    ? query.trim()
      ? `No ${descriptor?.label.toLowerCase()} matches “${query.trim()}”.`
      : `No ${descriptor?.label.toLowerCase()} values yet — memories pick these up as agents write them.`
    : `Nothing matches “${query.trim()}”.`;

  const list = (
    <div
      ref={listRef}
      id={LISTBOX_ID}
      role="listbox"
      {...(field ? { 'aria-multiselectable': true } : {})}
      aria-label={field ? `${descriptor?.label} values` : 'Filter by'}
      className={`${listMaxH} overflow-y-auto p-1`}
      style={{ scrollPaddingBlock: '0.5rem' }}
    >
      {rowCount === 0 ? (
        <p className="px-2 py-3 text-center text-[11px] text-[var(--color-content-tertiary)]">
          {emptyCopy}
        </p>
      ) : field ? (
        valueRows.map((option, i) => {
          const isSelected = selectedValues(filters, field).includes(option.value);
          return (
            <button
              key={option.value}
              id={`${OPTION_ID_PREFIX}${i}`}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => toggleValueRow(i, { close: false })}
              onMouseEnter={() => setActiveIndex(i)}
              className={[
                'flex w-full min-h-8 items-center gap-2 rounded-md px-2 text-left text-xs',
                i === activeIndex ? 'bg-[var(--color-bg-elevated)]' : '',
                isSelected
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-content-secondary)]',
              ].join(' ')}
            >
              {/* The checkbox slot is always reserved, so nothing shifts
                  horizontally when a row is toggled. */}
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
              <span className="flex-1 truncate">{descriptor?.format(option.value)}</span>
              {option.count !== null && (
                <span className="shrink-0 tabular-nums text-[var(--color-content-tertiary)]">
                  {option.count}
                </span>
              )}
            </button>
          );
        })
      ) : (
        rootRows.map((row, i) => {
          const rowField = requireField(row.field);
          const Icon = FIELD_ICONS[row.field];
          const isValueRow = row.kind === 'value';
          return (
            <button
              key={isValueRow ? `${row.field}:${row.value}` : row.field}
              id={`${OPTION_ID_PREFIX}${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => commitRootRow(i)}
              onMouseEnter={() => setActiveIndex(i)}
              className={[
                'flex w-full min-h-8 items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--color-content-secondary)]',
                i === activeIndex ? 'bg-[var(--color-bg-elevated)]' : '',
              ].join(' ')}
            >
              <Icon className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
              {isValueRow ? (
                <>
                  {/* Fully qualified, so a value row is never mistaken for a
                      dimension row — `main` alone would be ambiguous. */}
                  <span className="shrink-0 text-[var(--color-content-tertiary)]">
                    {rowField.label}
                  </span>
                  <span className="flex-1 truncate text-[var(--color-content-primary)]">
                    {rowField.format(row.value)}
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--color-content-tertiary)]">
                    {row.count}
                  </span>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate">{rowField.label}</span>
                  <ChevronRight
                    className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]"
                    aria-hidden
                  />
                </>
              )}
            </button>
          );
        })
      )}
    </div>
  );

  const panel = (
    <>
      {/* Breadcrumb — only at level 2. It is also the pointer user's "back":
          the keyboard has ← and Backspace, a mouse has nothing without it. */}
      {field && (
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-1.5 py-1.5">
          <button
            type="button"
            onClick={popLevel}
            aria-label="Back to filter types"
            className="flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-[var(--color-content-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
          >
            <ChevronLeft className="size-3" aria-hidden />
            {descriptor?.label}
          </button>
        </div>
      )}

      {/* Search — borderless and transparent so it reads as part of the surface
          and flows straight into the rows (mirrors CommandPalette). The input
          holds focus the whole time the menu is open, so its own focus ring is
          suppressed; the highlighted active row is the affordance instead. */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Search className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={rowCount > 0 ? `${OPTION_ID_PREFIX}${activeIndex}` : undefined}
          aria-label={field ? `Search ${descriptor?.label.toLowerCase()} values` : 'Search filters'}
          placeholder={field ? descriptor?.searchPlaceholder : 'Filter by…'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleInputKeyDown}
          className="flex-1 bg-transparent text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] !outline-none"
        />
      </div>

      {/* The level transition: a short slide in the direction of travel plus a
          height morph, so the surface reads as one menu changing contents. */}
      <div className="relative overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={field ?? '__root__'}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: field ? 12 : -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: field ? -12 : 12 }}
            transition={{ duration: reduceMotion ? 0.1 : 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            {list}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer: the two keys that are not guessable. Stating them costs one
          line and removes the only reason to reach for the mouse mid-flow. */}
      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-2.5 py-1.5 text-[10px] leading-tight text-[var(--color-content-tertiary)]">
        {field ? (
          <>
            <span>
              <kbd className="font-sans">Space</kbd> select
            </span>
            <span>
              <kbd className="font-sans">Enter</kbd> apply &amp; close
            </span>
          </>
        ) : (
          <>
            <span>Filters combine with AND</span>
            <span>
              <kbd className="font-sans">→</kbd> open
            </span>
          </>
        )}
      </div>
    </>
  );

  return (
    <div ref={containerRef} onKeyDown={handleContainerKeyDown} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => (open ? closeMenu() : openMenu())}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={triggerDescription}
        title={desktop ? triggerDescription : undefined}
        className={[
          'flex min-h-9 shrink-0 items-center rounded-lg border transition-colors duration-150',
          desktop ? 'gap-1.5 px-2.5 py-1.5 text-xs font-medium' : 'gap-1 px-2 py-2',
          // The trigger stays visually active while its menu is open, so the
          // surface never looks orphaned from the control that opened it.
          open
            ? 'border-[var(--color-content-tertiary)] bg-[var(--color-bg-elevated)] text-[var(--color-content-primary)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
        ].join(' ')}
      >
        <ListFilter className={desktop ? 'size-3.5 shrink-0' : 'size-4 shrink-0'} aria-hidden />
        {desktop ? (
          <span>Filter</span>
        ) : (
          activeCount > 0 && (
            <span className="text-xs font-medium tabular-nums">{activeCount}</span>
          )
        )}
      </button>

      {useSheet ? (
        <BottomSheet open={open} onClose={closeMenu} title={descriptor?.label ?? 'Filter by'}>
          {panel}
        </BottomSheet>
      ) : (
        <AnimatePresence>
          {open && (
            <motion.div
              role="dialog"
              aria-label="Filter"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
              className="absolute left-0 top-full z-40 mt-1.5 w-72 origin-top-left overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-lg"
            >
              {panel}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
