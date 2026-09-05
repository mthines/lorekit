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
 * ## Why the popover is portaled
 * It is NOT `absolute` inside the trigger's container. The trigger sits in the
 * Explorer's control row, which lives inside `overflow-hidden` panels and a
 * scrolling results column, so an in-flow popover is clipped by the first of
 * those ancestors and cannot be scrolled to — the menu is simply cut off. A
 * portal to `document.body` takes it out of every ancestor's overflow and
 * stacking context; the cost is that position must be computed rather than
 * inherited, which {@link useAnchoredPosition} does from the trigger's rect.
 *
 * That position is recomputed on scroll (capture phase, so it sees ANY
 * ancestor scrolling, not just the window) and on resize, because a fixed
 * element does not follow an anchor that moves. It also picks the side with
 * more room and caps the list to the space actually available, so the menu is
 * never taller than the viewport it now escapes.
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
 *
 * ## Age & activity lives here too, as five ordinary rows
 * The five retention thresholds (`lib/retention-filter.ts` — Created, Last
 * agent open, Recurrence, Delivered, Chosen) are siblings of the categorical
 * dimensions at level 1, under a group heading, and each drills into its own
 * preset list at level 2. They used to be a SECOND trigger opening a panel of
 * five number inputs, which put two filter surfaces on one toolbar and left a
 * reader two places to ask "what is narrowing this list?".
 *
 * They differ from a dimension in exactly two ways, both of which follow from
 * a threshold holding ONE value rather than a set:
 *
 * - Picking a value applies it and pops back to level 1 instead of staying put,
 *   so conditions chain (`Created → 30 → Chosen → 0`) without a trip through
 *   the trigger. A dimension stays because its next pick is another value of
 *   the SAME dimension; a threshold's is not.
 * - The search box doubles as the custom-value input. There is no facet catalog
 *   of "ages" to enumerate, so `retentionValueRows` offers whatever legal
 *   number is typed alongside the matching presets — which is why there is no
 *   "Custom…" row and no third level.
 *
 * Both props are optional together: a caller that passes neither gets the menu
 * without the section, exactly like `status`/`onStatusChange`.
 *
 * ## Status lives here too, but it is NOT a dimension
 * A pinned "Status" row group sits above the search box at level 1, built
 * from `MEMORY_STATUSES`/`STATUS_LABELS`/`STATUS_ICONS` (`lib/status-filter.ts`
 * — the same source the old standalone `StatusControl` button read from
 * before it was folded in here). It is a radiogroup, not part of
 * `rootRows`/`valueRows`: a memory is always in exactly one of
 * active/archived/expiring, so "select more than one" has to stay
 * unreachable, the same constraint `StatusControl` enforced. Picking a status
 * calls `onStatusChange` directly and never touches `filters` or the pill
 * row — it selects which population the list reads from, the same
 * `?status=` URL param as before, just relocated into this menu instead of a
 * separate toolbar button. See `LoreExplorer`'s `isNarrowedWithinView` for why
 * that distinction (population vs. predicate) matters beyond this component.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Bot,
  Boxes,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  GitBranch,
  GitPullRequest,
  History,
  ListFilter,
  MousePointerClick,
  Repeat,
  Search,
  Server,
  Tag,
  Users,
  Zap,
  FolderGit2,
  type LucideIcon,
} from 'lucide-react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import {
  anchoredPosition,
  type AnchoredPosition,
} from '@/lib/anchored-position';
import {
  FILTER_FIELDS,
  facetOptions,
  filterCount,
  requireField,
  rootSuggestions,
  searchOptions,
  selectedValues,
  type FacetValue,
  type Filter,
  type FilterField,
  type RootSuggestion,
} from '@/lib/filters';
import {
  RETENTION_CONDITION_BOUNDS,
  requireRetentionField,
  retentionConditionsCount,
  retentionFieldMatches,
  retentionValueRows,
  setRetentionCondition,
  type RetentionConditions,
  type RetentionField,
} from '@/lib/retention-filter';
import {
  DEFAULT_STATUS,
  MEMORY_STATUSES,
  STATUS_HINTS,
  STATUS_ICONS,
  STATUS_LABELS,
  type MemoryStatus,
} from '@/lib/status-filter';

/** One icon per dimension, so a row is recognisable before it is read. */
export const FIELD_ICONS: Record<FilterField, LucideIcon> = {
  label: Tag,
  // Kind is a bucket TYPE (lesson / bus / signal) — boxes, not a tag.
  kind: Boxes,
  // Host is the skill or agent that owns the bucket; Bot is already Agent, so
  // the owner reads as the thing the agent runs on rather than a second robot.
  host: Server,
  // Ownership — personal vs a shared org, i.e. WHO the lore belongs to.
  owner: Users,
  agent: Bot,
  trigger: Zap,
  repo: FolderGit2,
  branch: GitBranch,
  pr: GitPullRequest,
};

/**
 * One icon per age/activity threshold, in the same slot a dimension's icon
 * occupies — the rows sit in one list, so a threshold without an icon would
 * read as a differently-shaped row rather than as a sibling.
 *
 * Each names its DATA rather than its condition: a calendar-plus for when a
 * lesson was written, a clock-history for when one was last opened, a repeat
 * for how often it recurred, a download for how often it was delivered, a
 * pointer for how often something chose it.
 */
export const RETENTION_FIELD_ICONS: Record<RetentionField, LucideIcon> = {
  minAgeDays: CalendarPlus,
  unseenDays: History,
  maxSeenCount: Repeat,
  maxReadCount: Download,
  maxOpenedCount: MousePointerClick,
};

/**
 * A level-1 row: one of `rootSuggestions`' dimension/value rows, or one of the
 * five thresholds. A flat union rather than two lists, because `activeIndex`
 * addresses ONE array — splitting them would mean two index spaces and an
 * arrow key that has to know which half it is in.
 */
type MenuRootRow = RootSuggestion | { kind: 'retention'; field: RetentionField };

/**
 * Which value list is showing, or `null` for the level-1 row list. A
 * discriminated union rather than two nullable fields, so "a dimension AND a
 * threshold are both open" is unrepresentable.
 */
type MenuLevel =
  | { kind: 'filter'; field: FilterField }
  | { kind: 'retention'; field: RetentionField };

/**
 * This menu's own list height, overriding the shared default the way
 * `FilterPill`'s operator listbox overrides it downward.
 *
 * Level one is now nine dimensions AND five thresholds under a heading — about
 * 380px of rows. At the shared 256px default the whole age/activity group sat
 * below the fold on first open, which for a section a reader does not yet know
 * exists is the same as it not being there. It is still a cap: `anchoredPosition`
 * takes the smaller of this and the space actually available, so a short viewport
 * shrinks the list rather than pushing it off-screen.
 */
const FILTER_MENU_SIZE = { maxListHeight: 400 } as const;

const LISTBOX_ID = 'filter-menu-listbox';
const OPTION_ID_PREFIX = 'filter-menu-option-';

interface FilterMenuProps {
  /** Every filterable value with its count, from `GET /memories/facets`. */
  facets: FacetValue[];
  /** The committed filter bar — drives which value rows read as selected. */
  filters: Filter[];
  onToggleValue: (field: FilterField, value: string) => void;
  /**
   * The Explorer's Status selection, rendered as a pinned radiogroup at level
   * 1 (see "Status lives here too" above). Optional so a caller that has no
   * use for it (a story, a future embed) can render the menu without it —
   * omitting either prop simply hides the section, it does not error.
   */
  status?: MemoryStatus;
  onStatusChange?: (status: MemoryStatus) => void;
  /**
   * The Explorer's age/activity thresholds, rendered as five more level-1 rows
   * (see "Age & activity lives here too" above). Optional TOGETHER with
   * `onRetentionChange` — passing neither hides the section, which is how
   * `LoreExplorer` keeps the whole thing behind its `retention-policies` flag
   * without this component learning about flags.
   *
   * Optional rather than required-with-a-default deliberately: a required prop
   * is not enforced across a Storybook `meta.args`/story `args` split, so
   * making it required buys a compile-time guarantee that does not exist and
   * costs an `undefined` read at render time.
   */
  retention?: RetentionConditions;
  onRetentionChange?: (next: RetentionConditions) => void;
  /**
   * `desktop` anchors a popover and labels the trigger; `mobile` opens the same
   * body in a `BottomSheet` and shows an icon with a count badge.
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
  /** The same request from a retention pill's value segment — see {@link openAtField}. */
  openAtRetentionField?: RetentionField | null;
  onOpenAtRetentionFieldHandled?: () => void;
  className?: string;
}

export function FilterMenu({
  facets,
  filters,
  onToggleValue,
  status,
  onStatusChange,
  retention,
  onRetentionChange,
  variant,
  openAtField = null,
  onOpenAtFieldHandled,
  openAtRetentionField = null,
  onOpenAtRetentionFieldHandled,
  className = '',
}: FilterMenuProps) {
  const reduceMotion = useReducedMotion();
  const useSheet = variant === 'mobile';
  const desktop = variant === 'desktop';

  // Both halves of the retention section must be present for it to render, so
  // one flag stands in for "the caller wants thresholds" everywhere below and
  // TypeScript narrows both props off it.
  const retentionEnabled = retention !== undefined && onRetentionChange !== undefined;

  const [open, setOpen] = useState(false);
  /** `null` = the level-1 row list; a level = one row list's values (level 2). */
  const [level, setLevel] = useState<MenuLevel | null>(null);
  // Derived so the bulk of the component still reads in terms of "which
  // dimension" / "which threshold" rather than unpacking the union at every use.
  const field = level?.kind === 'filter' ? level.field : null;
  const retentionField = level?.kind === 'retention' ? level.field : null;
  /**
   * The level the menu was opened at. Escape/Backspace pop back to it and no
   * further: a menu opened on a pill's value segment closes rather than
   * revealing a dimension list the user never asked for.
   */
  const [entryDepth, setEntryDepth] = useState(0);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Portal target + anchored position (popover only) ──────────────────────
  // Resolved after mount so SSR renders nothing — `document` is client-only.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPosition(
      anchoredPosition(
        trigger.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        FILTER_MENU_SIZE,
      ),
    );
  }, []);

  // A safety net only. The real measurement happens synchronously in
  // `openMenu` / the `openAtField` effect, BEFORE `open` flips — and that
  // ordering is load-bearing, not an optimisation: an unmeasured popover
  // renders `visibility: hidden`, and a hidden element cannot take focus, so
  // the "focus the search box on open" effect would silently no-op and every
  // key the user pressed would go to the document instead of the combobox.
  useLayoutEffect(() => {
    if (!open || useSheet || position) return;
    measure();
  }, [open, useSheet, position, measure]);

  // A fixed element does not follow an anchor that moves. `capture: true` is
  // load-bearing: scroll does not bubble, and the trigger's nearest scrolling
  // ancestor is the Explorer's results column, not the window — without it the
  // menu detaches from its trigger the moment the page behind it scrolls.
  useEffect(() => {
    if (!open || useSheet) return;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, useSheet, measure]);

  /** Open straight at one value list, the way a pill's value segment asks for. */
  const openAtLevel = useCallback(
    (next: MenuLevel) => {
      // Measure before opening — see the layout effect below for why.
      if (!useSheet) measure();
      setLevel(next);
      setEntryDepth(1);
      setQuery('');
      setActiveIndex(0);
      setOpen(true);
    },
    [useSheet, measure],
  );

  // A pill's value segment asks for the menu at level 2 of one dimension.
  useEffect(() => {
    if (!openAtField) return;
    openAtLevel({ kind: 'filter', field: openAtField });
    onOpenAtFieldHandled?.();
  }, [openAtField, onOpenAtFieldHandled, openAtLevel]);

  // The same, from a retention pill. Gated on the section existing: without a
  // setter every row in that list would be inert, and an open menu nothing
  // responds to is worse than no menu.
  useEffect(() => {
    if (!openAtRetentionField || !retentionEnabled) return;
    openAtLevel({ kind: 'retention', field: openAtRetentionField });
    onOpenAtRetentionFieldHandled?.();
  }, [openAtRetentionField, retentionEnabled, onOpenAtRetentionFieldHandled, openAtLevel]);

  // ── Rows for the current level ─────────────────────────────────────────────

  // Dimensions first, thresholds after — one array, so `activeIndex` addresses
  // the whole list and the arrows walk from Pull request straight into Created.
  // The thresholds keep their own declaration order (`RETENTION_FIELDS`) rather
  // than being interleaved by relevance: they are a labelled group, and a group
  // whose members move around under a heading is harder to learn than one that
  // does not.
  const rootRows = useMemo<MenuRootRow[]>(() => {
    const dimensions: MenuRootRow[] = rootSuggestions(facets, query);
    if (!retentionEnabled) return dimensions;
    return [
      ...dimensions,
      ...retentionFieldMatches(query).map((f) => ({ kind: 'retention' as const, field: f })),
    ];
  }, [facets, query, retentionEnabled]);

  const valueRows = useMemo(() => {
    if (!field) return [];
    return searchOptions(facetOptions(facets, field, selectedValues(filters, field)), query);
  }, [facets, field, filters, query]);

  const retentionRows = useMemo(
    () => (retentionField ? retentionValueRows(retentionField, query) : []),
    [retentionField, query],
  );

  const rowCount = retentionField
    ? retentionRows.length
    : field
      ? valueRows.length
      : rootRows.length;

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

  // Close on click-outside — popover only. The sheet owns its own dismissal.
  //
  // BOTH refs are checked, and that is the whole point: the popover is portaled
  // to `document.body`, so it is NOT inside `containerRef` and a click on one of
  // its own rows would otherwise read as "outside" and close it on the first
  // pick. (The sheet has the same property, which is why it is excluded below.)
  const handleClickOutside = useCallback((e: MouseEvent) => {
    const target = e.target as Node;
    if (containerRef.current?.contains(target)) return;
    if (popoverRef.current?.contains(target)) return;
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open || useSheet) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, useSheet, handleClickOutside]);

  // ── Navigation ─────────────────────────────────────────────────────────────

  function openMenu() {
    // Measure first: the popover must have a position on its very FIRST render,
    // because an unmeasured one is `visibility: hidden` and a hidden element
    // silently refuses focus — which would leave the search box unfocused and
    // every keystroke going to the document.
    if (!useSheet) measure();
    setLevel(null);
    setEntryDepth(0);
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
  }

  function pushLevel(next: MenuLevel) {
    setLevel(next);
    // Clearing the query on push is what makes the dimension list searchable
    // AND the value list searchable with one box: the query that found the
    // dimension is meaningless against its values.
    setQuery('');
    setActiveIndex(0);
    // Popover only, for the same reason the open effect does not auto-focus in
    // the sheet: on a phone, focusing the search box raises the on-screen
    // keyboard, which scrolls the sheet up and off the values the user just
    // drilled into — the keyboard covers exactly the content they came to see.
    // They tap the field when they actually want to type.
    if (!useSheet) inputRef.current?.focus();
  }

  /** Back one level, or close when already at the level the menu opened on. */
  function popLevel() {
    if (level === null || entryDepth === 1) {
      closeMenu();
      return;
    }
    setLevel(null);
    setQuery('');
    setActiveIndex(0);
    // Popover only — see `pushLevel` for why the sheet must not grab focus here.
    if (!useSheet) inputRef.current?.focus();
  }

  function commitRootRow(index: number) {
    const row = rootRows[index];
    if (!row) return;
    if (row.kind === 'field') {
      pushLevel({ kind: 'filter', field: row.field });
      return;
    }
    if (row.kind === 'retention') {
      pushLevel({ kind: 'retention', field: row.field });
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

  /**
   * Apply (or clear) one threshold and go BACK to the row list rather than
   * staying put or closing.
   *
   * A threshold holds one value, so there is no "toggle a second value of the
   * same field" to stay for; and the next thing a reader wants after
   * `Created → 30 days` is almost always another threshold, not the results.
   * Landing back at level 1 makes chaining the default and still leaves Escape
   * as the one-key way out.
   *
   * Picking the value already in force CLEARS it, so a row is a real toggle and
   * the menu is a second way to undo what the pill's × undoes.
   */
  function commitRetentionRow(index: number) {
    const row = retentionRows[index];
    if (!row || !retentionField || !retention || !onRetentionChange) return;
    const cleared = retention[retentionField] === row.value;
    onRetentionChange(
      setRetentionCondition(retention, retentionField, cleared ? undefined : row.value),
    );
    if (entryDepth === 1) {
      closeMenu();
      return;
    }
    setLevel(null);
    setQuery('');
    setActiveIndex(0);
    if (!useSheet) inputRef.current?.focus();
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
    if (e.key === 'ArrowRight' && level === null) {
      // Only when the caret is at the end, so Right still moves through text
      // the user is editing.
      const atEnd = e.currentTarget.selectionStart === query.length;
      if (!atEnd) return;
      const row = rootRows[activeIndex];
      if (row?.kind === 'field') {
        e.preventDefault();
        pushLevel({ kind: 'filter', field: row.field });
      } else if (row?.kind === 'retention') {
        e.preventDefault();
        pushLevel({ kind: 'retention', field: row.field });
      }
      return;
    }
    if (e.key === 'ArrowLeft' && level !== null && caretAtStart) {
      e.preventDefault();
      popLevel();
      return;
    }
    if (e.key === 'Backspace' && level !== null && query === '') {
      e.preventDefault();
      popLevel();
      return;
    }
    if (e.key === ' ' && level !== null && query === '') {
      e.preventDefault();
      // A dimension toggles without leaving — the next pick is more likely than
      // not another value of the same field. A threshold has no second value,
      // so Space does what Enter does rather than pretending to multi-select.
      if (retentionField) commitRetentionRow(activeIndex);
      else toggleValueRow(activeIndex, { close: false });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (level === null) commitRootRow(activeIndex);
      else if (retentionField) commitRetentionRow(activeIndex);
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
  const retentionDescriptor = retentionField ? requireRetentionField(retentionField) : null;
  /** The level-2 heading, whichever kind of list is showing. */
  const levelLabel = retentionDescriptor?.label ?? descriptor?.label ?? null;
  // `filterCount`, not `filters.length`: it normalises first, so the badge
  // counts committed conditions rather than array entries — the same
  // defensiveness `filtersPhrase` already gives this prop in `FilterBar`.
  const activeCount = filterCount(filters);
  // Status has no standalone button any more (see "Status lives here too"
  // above), so the trigger has to say which population is showing whenever
  // it is not the default — otherwise switching to Archived and closing the
  // menu leaves nothing on the toolbar naming the view.
  const statusIsNonDefault = status !== undefined && status !== DEFAULT_STATUS;
  // Preserves the original two-state copy exactly ("Add filter" when nothing
  // is narrowing the view, "<what's applied>. Add or edit a filter"
  // otherwise) — only the middle clause is new. A version that always
  // appended "Add or edit a filter" would read as "you already have a
  // filter" on first load, which is what `FilterMenu.test.stories.tsx`'s
  // `/add filter/i` queries pin against regressing.
  // Thresholds are filters now, so they count toward the trigger exactly like a
  // dimension does — the whole point of folding them in is that there is ONE
  // answer to "what is narrowing this list?".
  const retentionCount = retention ? retentionConditionsCount(retention) : 0;
  const appliedDescriptors = [
    activeCount + retentionCount > 0 ? `Filters: ${activeCount + retentionCount} applied.` : null,
    statusIsNonDefault ? `Status: ${STATUS_LABELS[status]}.` : null,
  ].filter(Boolean);
  const triggerDescription =
    appliedDescriptors.length > 0
      ? `${appliedDescriptors.join(' ')} Add or edit a filter`
      : 'Add filter';
  // Mobile's badge is a single number (no room for a label) — it already
  // meant "how many things are narrowing this view", so a non-default status
  // counts toward it exactly like a pill does.
  const mobileBadgeCount = activeCount + retentionCount + (statusIsNonDefault ? 1 : 0);

  // List sizing.
  //
  // The sheet gets a MIN height as well as a max, and the two are close
  // together on purpose: a sheet is anchored to the bottom edge, so every row
  // the content gains or loses moves the header, the search box and every row
  // under the user's thumb. Walking from the six-row dimension list into a
  // two-value dimension resized the whole surface mid-gesture and the next tap
  // landed on a different row than the one aimed at. Bounding the body to a
  // narrow 45–55vh band makes navigating between levels a content change rather
  // than a layout change; only a dimension with very few values still moves at
  // all, and then by at most the slack in that band.
  //
  // The popover keeps a content-driven height instead: it is anchored to a
  // trigger near the top of the page, so growth pushes DOWNWARD into empty
  // space and nothing the pointer is aiming at moves. A min height there would
  // buy nothing and would paint a tall empty box under a one-row result.
  const listStyle = useSheet
    ? { minHeight: '45vh', maxHeight: '55vh' }
    // Before the first measurement (the frame the popover mounts in) fall back
    // to the resting maximum rather than 0 — an unmeasured list must not be an
    // invisible one.
    : { maxHeight: position?.listMaxHeight ?? FILTER_MENU_SIZE.maxListHeight };

  // A threshold's list is never empty for want of data — it always has presets —
  // so the only way to see nothing here is to type something that is not a legal
  // value. Saying so, with the range, is the difference between "this filter is
  // broken" and "3651 is too many days".
  const retentionEmptyCopy = retentionField
    ? `“${query.trim()}” is not a value here — type a whole number from ${
        RETENTION_CONDITION_BOUNDS[retentionField].min
      } to ${RETENTION_CONDITION_BOUNDS[retentionField].max}.`
    : '';

  const emptyCopy = retentionField
    ? retentionEmptyCopy
    : field
      ? query.trim()
        ? `No ${descriptor?.label.toLowerCase()} matches “${query.trim()}”.`
        : `No ${descriptor?.label.toLowerCase()} values yet — memories pick these up as agents write them.`
      : `Nothing matches “${query.trim()}”.`;

  const list = (
    <div
      ref={listRef}
      id={LISTBOX_ID}
      role="listbox"
      // Only a dimension is multi-select. A threshold holds one value, so
      // announcing its list as multi-selectable would promise a second pick
      // that silently replaces the first.
      {...(field ? { 'aria-multiselectable': true } : {})}
      aria-label={levelLabel ? `${levelLabel} values` : 'Filter by'}
      className="overflow-y-auto p-1"
      style={{ ...listStyle, scrollPaddingBlock: '0.5rem' }}
    >
      {rowCount === 0 ? (
        <p className="px-2 py-3 text-center text-[11px] text-[var(--color-content-tertiary)]">
          {emptyCopy}
        </p>
      ) : retentionField && retentionDescriptor ? (
        <>
          {retentionRows.map((row, i) => {
            const isSelected = retention?.[retentionField] === row.value;
            return (
              <button
                key={row.value}
                id={`${OPTION_ID_PREFIX}${i}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => commitRetentionRow(i)}
                onMouseEnter={() => setActiveIndex(i)}
                className={[
                  'flex w-full min-h-8 items-center gap-2 rounded-md px-2 text-left text-xs',
                  i === activeIndex ? 'bg-[var(--color-bg-elevated)]' : '',
                  isSelected
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-content-secondary)]',
                ].join(' ')}
              >
                {/* A radio, not a checkbox: the shape has to say "one of these"
                    before the reader discovers it by picking a second. */}
                <span
                  aria-hidden
                  className={[
                    'flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                    isSelected
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]'
                      : 'border-[var(--color-border)]',
                  ].join(' ')}
                >
                  {isSelected && <span className="size-1.5 rounded-full bg-[var(--color-accent)]" />}
                </span>
                <span className="flex-1 truncate">{retentionDescriptor.formatValue(row.value)}</span>
                {row.custom && (
                  // Labelled so a typed threshold is visibly a typed one and not
                  // a preset the reader misremembers next time.
                  <span className="shrink-0 text-[10px] text-[var(--color-content-tertiary)]">
                    custom
                  </span>
                )}
              </button>
            );
          })}
          {/* What the threshold actually tests, once under the list rather than
              once per row: the rows are numbers, and a number without its rule
              is the thing readers got wrong about `Delivered` vs `Chosen`. */}
          <p className="px-2 pb-1 pt-2 text-[10px] leading-snug text-[var(--color-content-tertiary)]">
            {retentionDescriptor.hint}
          </p>
        </>
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
          if (row.kind === 'retention') {
            const entry = requireRetentionField(row.field);
            const Icon = RETENTION_FIELD_ICONS[row.field];
            const value = retention?.[row.field];
            // The heading is rendered BETWEEN rows rather than as an entry in
            // `rootRows`, because `activeIndex` and the `role="option"` ids are
            // positional — a non-selectable element in the array would shift
            // every id past it and give the arrows a row they cannot land on.
            const startsGroup = rootRows[i - 1]?.kind !== 'retention';
            return (
              <div key={`retention:${row.field}`}>
                {startsGroup && (
                  <p
                    // `presentation`, not a heading: inside a listbox the only
                    // legal children are options and groups, and a real
                    // `role="group"` would have to wrap the rows — which the
                    // positional ids above rule out.
                    role="presentation"
                    className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]"
                  >
                    Age &amp; activity
                  </p>
                )}
                <button
                  id={`${OPTION_ID_PREFIX}${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  // The chosen value is a badge, and a badge is aria-hidden
                  // decoration — fold it into the name so a screen reader hears
                  // "Chosen, never chosen" rather than just "Chosen".
                  aria-label={
                    value !== undefined
                      ? `${entry.label}, ${entry.formatValue(value)}`
                      : undefined
                  }
                  onClick={() => commitRootRow(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={[
                    'flex w-full min-h-8 items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--color-content-secondary)]',
                    i === activeIndex ? 'bg-[var(--color-bg-elevated)]' : '',
                  ].join(' ')}
                >
                  <Icon
                    className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]"
                    aria-hidden
                  />
                  <span
                    className={[
                      'flex-1 truncate',
                      value !== undefined ? 'font-medium text-[var(--color-content-primary)]' : '',
                    ].join(' ')}
                  >
                    {entry.label}
                  </span>
                  {value !== undefined && (
                    <span
                      aria-hidden
                      // Wide enough for the longest common value ("More than
                      // 365 days ago") — at a tighter cap every date threshold
                      // truncated to "More than 30 d…", which is the half of
                      // the phrase that carries no information.
                      className="max-w-36 truncate rounded-full bg-[var(--color-accent-subtle)] px-1.5 text-[10px] font-semibold text-[var(--color-accent)]"
                    >
                      {entry.formatValue(value)}
                    </span>
                  )}
                  <ChevronRight
                    className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]"
                    aria-hidden
                  />
                </button>
              </div>
            );
          }
          const rowField = requireField(row.field);
          const Icon = FIELD_ICONS[row.field];
          const isValueRow = row.kind === 'value';
          // How many values this dimension already has committed. The count
          // badge is what tells the user, WITHOUT drilling in, which groups the
          // narrowed list is being filtered by — the list shrinks as filters
          // apply, but nothing on the dimension list said where that came from.
          // A value row is a whole condition, not a group, so it has no count.
          const selectedCount = isValueRow
            ? 0
            : selectedValues(filters, row.field).length;
          return (
            <button
              key={isValueRow ? `${row.field}:${row.value}` : row.field}
              id={`${OPTION_ID_PREFIX}${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              // A count badge is aria-hidden decoration; fold it into the name so
              // a screen-reader user hears "Label, 2 selected", not just "Label".
              aria-label={
                !isValueRow && selectedCount > 0
                  ? `${rowField.label}, ${selectedCount} selected`
                  : undefined
              }
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
                  <span
                    className={[
                      'flex-1 truncate',
                      selectedCount > 0
                        ? 'font-medium text-[var(--color-content-primary)]'
                        : '',
                    ].join(' ')}
                  >
                    {rowField.label}
                  </span>
                  {selectedCount > 0 && (
                    <span
                      aria-hidden
                      className="flex min-h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] px-1 text-[10px] font-semibold tabular-nums text-[var(--color-accent)]"
                    >
                      {selectedCount}
                    </span>
                  )}
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
      {/* Header. It carries the pointer user's "back" — the keyboard has ← and
          Backspace, a mouse has nothing without it.

          In the SHEET it is always present, and that is the second half of the
          don't-resize-on-navigate fix: bounding the list alone still let the
          surface grow by exactly this row's height when a level-two breadcrumb
          appeared. A row that is always there cannot cause a jump, and at level
          one it earns its space by naming the surface — which is also why the
          sheet is given no `title` of its own: two headers saying the same
          thing is what a conditional breadcrumb would otherwise produce.

          In the POPOVER it stays level-two-only: growth there is downward into
          empty space, so a placeholder row would cost a row and buy nothing. */}
      {(level || useSheet) && (
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-1.5 py-1.5">
          {level ? (
            <button
              type="button"
              onClick={popLevel}
              aria-label="Back to filter types"
              className="flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-[var(--color-content-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
            >
              <ChevronLeft className="size-3" aria-hidden />
              {levelLabel}
            </button>
          ) : (
            <span className="flex min-h-6 items-center px-1.5 text-[11px] font-medium text-[var(--color-content-tertiary)]">
              Filter by
            </span>
          )}
        </div>
      )}

      {/* Status — pinned above the dimension list, level 1 only. A radiogroup,
          not a set of `rootRows`: exactly one of the three is ever selected,
          and clicking one applies immediately without closing the menu (a
          reader picking "Archived" is very likely about to also want to
          narrow it further with a real filter). See "Status lives here too"
          above for why this cannot become a fourth `rootRows` entry. */}
      {!level && status !== undefined && onStatusChange && (
        <div
          role="radiogroup"
          aria-label="Status"
          className="flex items-center gap-1 border-b border-[var(--color-border)] p-1.5"
        >
          {MEMORY_STATUSES.map((s) => {
            const Icon = STATUS_ICONS[s];
            const selected = s === status;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={selected}
                title={STATUS_HINTS[s]}
                onClick={() => onStatusChange(s)}
                className={[
                  'flex min-h-7 flex-1 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors duration-150',
                  selected
                    ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                    : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                ].join(' ')}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                {STATUS_LABELS[s]}
              </button>
            );
          })}
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
          aria-label={
            levelLabel ? `Search ${levelLabel.toLowerCase()} values` : 'Search filters'
          }
          // At a threshold the box is ALSO the custom-value input (there is no
          // facet catalog to search), so the placeholder has to invite typing a
          // number rather than reading as a search over the five presets.
          placeholder={
            retentionDescriptor
              ? 'Pick one, or type a number…'
              : field
                ? descriptor?.searchPlaceholder
                : 'Filter by…'
          }
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
            key={level ? `${level.kind}:${level.field}` : '__root__'}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: level ? 12 : -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: level ? -12 : 12 }}
            transition={{ duration: reduceMotion ? 0.1 : 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            {list}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer: the two keys that are not guessable. Stating them costs one
          line and removes the only reason to reach for the mouse mid-flow. */}
      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-2.5 py-1.5 text-[10px] leading-tight text-[var(--color-content-tertiary)]">
        {retentionField ? (
          <>
            <span>One value per condition</span>
            <span>
              <kbd className="font-sans">Enter</kbd> apply
            </span>
          </>
        ) : field ? (
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
        ref={triggerRef}
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
          // Names the current status once it departs from the default, the
          // same way a pill would — otherwise the toolbar has nothing left
          // that says "you are looking at Archived" once the menu is closed.
          <span>{statusIsNonDefault ? `Filter · ${STATUS_LABELS[status]}` : 'Filter'}</span>
        ) : (
          mobileBadgeCount > 0 && (
            <span className="text-xs font-medium tabular-nums">{mobileBadgeCount}</span>
          )
        )}
      </button>

      {useSheet ? (
        // No `title`: the panel renders its own always-present header row (see
        // there), and a sheet title that appeared and changed alongside it
        // would both duplicate the label and re-introduce the height jump this
        // is fixing.
        <BottomSheet open={open} onClose={closeMenu} ariaLabel="Filter">
          {panel}
        </BottomSheet>
      ) : (
        // Portaled to `document.body`, so no ancestor's `overflow` can clip it
        // and no ancestor's stacking context can bury it. Rendered inside this
        // component's JSX tree, so React events still bubble to the container's
        // `onKeyDown` — the staged-Escape handler keeps working unchanged.
        portalTarget &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={popoverRef}
                data-testid="filter-menu-popover"
                role="dialog"
                aria-label="Filter"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
                transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  left: position?.left ?? 0,
                  ...(position?.bottom != null
                    ? { bottom: position.bottom }
                    : { top: position?.top ?? 0 }),
                  // Hidden until measured: one frame at the wrong coordinates
                  // reads as the menu jumping into place.
                  visibility: position ? 'visible' : 'hidden',
                }}
                className={[
                  'fixed z-50 w-72 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-lg',
                  position?.bottom != null ? 'origin-bottom-left' : 'origin-top-left',
                ].join(' ')}
              >
                {panel}
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )
      )}
    </div>
  );
}
