'use client';

/**
 * LoreExplorer
 *
 * Two-panel layout (scope tree + paginated lesson list) for the Lore page.
 * Includes a collapsible heatmap panel at the top and a "Browse by time" tab
 * that surfaces the ActivityFeed view, replacing the old /activity route.
 *
 * ## Key changes from the previous client-filtered version
 * - Default view is "all scopes" (no scope selected). The scope tree has an
 *   "all" row at the top that clears the scope filter.
 * - Filtering (scope / search / date) is server-side, not client-side.
 *   `useMemories` (`useInfiniteQuery` over `listMemories`) is the data source.
 * - Pagination: "Load more" button appends the next keyset page, identical to
 *   the audit log feed (`AuditLogFeed.tsx`).
 * - The scope sidebar still reads a lightweight `useScopeTree()` query so the
 *   tree renders immediately without waiting for the lesson list.
 *
 * ## URL state
 * - `scope` param:    selected scope (null → all scopes). Shareable.
 * - `q` param:        search query, debounced write. Shareable.
 * - `tags` param:     selected labels (JSON array). A memory must carry ALL of
 *   them. Server-side, shareable — "every perf regression we've learned" is a
 *   link you can paste to a teammate.
 * - `range` param:    date range, shareable. Scoped to /lore. Shared by the
 *   heatmap click, scope view, and feed view — one param drives all three.
 * - `view` param:     'scope' | 'time'. Persisted in URL so a shared link
 *   lands on the correct tab.
 * - `status` param:   'active' | 'archived' | 'expiring'. The population being
 *   viewed, as opposed to the filters that narrow it. Absent means "fall back
 *   to the legacy `archived` flag", which is why its default is `null` rather
 *   than `'active'`.
 * - `archived` param: the superseded boolean. Still READ so existing links keep
 *   resolving; never written. Same treatment as the legacy `tags` shorthand.
 * - `scopePanelOpen`: local useState — ephemeral mobile accordion, NOT in URL.
 *   Defaults to closed so the phone layout leads with the memories.
 * - `heatmapOpen`:    local useState — ephemeral panel collapse, NOT in URL.
 *
 * ## SSR note
 * Uses `useSearchParams()` via `useUrlState`. Must be wrapped in <Suspense>.
 */

import { useCallback, useMemo, useTransition, useState } from 'react';
import { Search, BookOpen, ChevronDown, ChevronUp, Loader2, List, LayoutGrid, Archive, Clock, User, Building2, Users } from 'lucide-react';
import { ScopeTree, type ScopeNode } from './ScopeTree';
import { LessonCard } from './LessonCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useDebouncedUrlState } from '@/lib/hooks/useDebouncedUrlState';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { DateRangePicker, type DateRange } from '@/components/ui/DateRangePicker';
import { StatusControl } from './StatusControl';
import {
  DEFAULT_STATUS,
  EXPIRING_WITHIN_DAYS,
  expiringWithinDays,
  isArchivedView,
  resolveStatus,
  statusParamValue,
  type MemoryStatus,
} from '@/lib/status-filter';

/**
 * The empty-state icon per status. Declared as an exhaustive record so a fourth
 * status cannot ship without one — the same reason `FIELD_ICONS` is a
 * `Record<FilterField, …>`.
 */
const EMPTY_STATE_ICONS: Record<MemoryStatus, typeof BookOpen> = {
  active: BookOpen,
  archived: Archive,
  expiring: Clock,
};
import { useFacetCatalog, useMemories } from '@/lib/queries/lore';
import {
  filtersParamValue,
  removeFilter,
  resolveFilters,
  setFilterOperator,
  toggleFilterValue,
  type FacetValue,
  type Filter,
  type FilterField,
  type FilterOperator,
} from '@/lib/filters';
import { FilterMenuTrigger, FilterPillRow } from './FilterBar';
import { useReducedMotion } from 'motion/react';
import type { LessonEntry } from './LessonCard';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed } from '@/components/activity/ActivityFeed';
import { filterByOwnership, type OwnerFilter } from '@/lib/org-ui';

type ViewMode = 'scope' | 'time';

// Module-scoped so the reference is stable across renders — `useUrlState`
// documents that mutable defaults must be memoized at the call site.
const NO_TAGS: string[] = [];
const NO_FILTERS: Filter[] = [];

// ── Ownership filter bar ──────────────────────────────────────────────────────
// "Owner: All · Personal · {org}" per ux-design §4 — only rendered when at least
// one org-owned memory is in view (nothing to filter by ownership otherwise).
// A leading "Owner" label + per-chip icons make the dimension self-explanatory:
// without them the bare "Personal / {org}" chips read as unlabelled mystery
// filters. Single-select, so it uses radiogroup/radio semantics (aria-checked),
// not the toggle-button aria-pressed shape.

function OwnershipFilterBar({
  orgs,
  value,
  onChange,
}: {
  orgs: { id: string; name: string }[];
  value: OwnerFilter;
  onChange: (next: OwnerFilter) => void;
}) {
  if (orgs.length === 0) return null;

  function isActive(candidate: OwnerFilter): boolean {
    if (candidate === 'all') return value === 'all';
    if (candidate === 'personal') return value === 'personal';
    return typeof value === 'object' && value.orgId === candidate.orgId;
  }

  const chips: {
    key: string;
    label: string;
    filter: OwnerFilter;
    icon: typeof User;
    title: string;
  }[] = [
    { key: 'all', label: 'All', filter: 'all', icon: Users, title: 'Show memories from every owner' },
    { key: 'personal', label: 'Personal', filter: 'personal', icon: User, title: 'Only your personal memories' },
    ...orgs.map((org) => ({
      key: org.id,
      label: org.name,
      filter: { orgId: org.id } as OwnerFilter,
      icon: Building2,
      title: `Only memories shared with ${org.name}`,
    })),
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Filter by owner"
      className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2"
    >
      <span className="mr-0.5 flex items-center text-xs font-medium text-[var(--color-content-tertiary)]">
        Owner
      </span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          role="radio"
          onClick={() => onChange(chip.filter)}
          aria-checked={isActive(chip.filter)}
          title={chip.title}
          className={[
            'flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150',
            isActive(chip.filter)
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
          ].join(' ')}
        >
          <chip.icon className="size-3 shrink-0" aria-hidden />
          {chip.label}
        </button>
      ))}
    </div>
  );
}

// ── Filter bar (search + filters + date + status) ─────────────────────────────
// Shared by both tabs and both breakpoints. `variant` carries the only two
// differences between the desktop and mobile renders: the desktop bar sits in a
// bordered header (`border-b`/padding), uses smaller type + the page `bg`, and
// shows text labels + hover affordances; the mobile bar is a bare row with
// icon-only toggles on the raised `bg`. Everything else — the search input, the
// label picker, the date picker, the toggle behaviour — is identical, so it
// lives here once instead of near-verbatim in each breakpoint branch.
//
// The filter menu is one trigger for every dimension rather than one trigger
// per dimension: the values of each dimension grow without bound, and so does
// the number of dimensions. Its committed conditions render as pills on their
// own line below (`FilterPillRow`), because a control row is fixed-width and a
// filter set is not. See `FilterMenu`.

function ControlRow({
  variant,
  search,
  onSearchChange,
  facets,
  filters,
  onToggleFilterValue,
  editingField,
  onEditField,
  range,
  onRangeChange,
  status,
  onStatusChange,
}: {
  variant: 'desktop' | 'mobile';
  search: string;
  onSearchChange: (value: string) => void;
  facets: FacetValue[];
  filters: Filter[];
  onToggleFilterValue: (field: FilterField, value: string) => void;
  editingField: FilterField | null;
  onEditField: (field: FilterField | null) => void;
  range: DateRange | null;
  onRangeChange: (range: DateRange | null) => void;
  status: MemoryStatus;
  onStatusChange: (status: MemoryStatus) => void;
}) {
  const desktop = variant === 'desktop';

  return (
    <div className={desktop ? 'flex items-center gap-2 border-b border-[var(--color-border)] p-3' : 'flex items-center gap-2'}>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]" aria-hidden />
        <input
          type="search"
          placeholder="Search memories…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search memories"
          className={[
            'w-full rounded-lg border border-[var(--color-border)] py-2 pl-8 pr-3 text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-150',
            desktop ? 'bg-[var(--color-bg)] text-xs' : 'bg-[var(--color-bg-raised)] text-sm',
          ].join(' ')}
        />
      </div>
      <FilterMenuTrigger
        facets={facets}
        filters={filters}
        onToggleValue={onToggleFilterValue}
        editingField={editingField}
        onEditField={onEditField}
        variant={variant}
      />
      <DateRangePicker value={range} onChange={onRangeChange} className="shrink-0" />
      <StatusControl value={status} onChange={onStatusChange} variant={variant} />
    </div>
  );
}

interface LoreExplorerProps {
  scopes: ScopeNode[];
  heatmapData: { date: string; count: number }[];
}

export function LoreExplorer({ scopes, heatmapData }: LoreExplorerProps) {
  const { openLesson, openLessonById, closeLesson } = useMemorySidebar();
  const [, startTransition] = useTransition();
  const reduceMotion = useReducedMotion();

  // URL-backed: null means "all scopes" (the new default). A discrete click
  // writes the URL immediately (no debounce). Scoped to /lore.
  const [selectedScope, setSelectedScope] = useUrlState<string | null>('scope', null, {
    cleanOnPathname: '/lore',
  });

  // Search is high-frequency input — the returned `search` is instantly
  // responsive (local state) while the URL param is written on a trailing
  // debounce. The *server query* keys off the settled URL value (committedSearch)
  // so the server action fires only after the debounce settles, not on every
  // keystroke. Mirrors the AuditLogFeed pattern exactly.
  const [search, setSearch] = useDebouncedUrlState<string>('q', '', {
    debounceMs: 350,
    cleanOnPathname: '/lore',
  });
  const [committedSearch] = useUrlState<string>('q', '', {
    cleanOnPathname: '/lore',
  });

  // URL-backed date range, scoped to /lore. Shared by the heatmap click, the
  // scope view, and the feed view — one param drives all three.
  const [range, setRange] = useUrlState<DateRange | null>('range', null, {
    cleanOnPathname: '/lore',
  });

  // URL-backed ownership filter (plan.md Decision D9) — shareable, and the
  // accept-invite flow deep-links here (`/lore?owner=<serialised OwnerFilter>`)
  // so a freshly-joined org is pre-filtered on arrival.
  const [ownerFilter, setOwnerFilter] = useUrlState<OwnerFilter>('owner', 'all', {
    cleanOnPathname: '/lore',
  });

  // URL-backed filter bar — server-side filtered (OR within a dimension, AND
  // across dimensions), so it belongs in the query, not in a client-side
  // narrowing like `owner`. Shareable: "every perf regression we learned on the
  // release branch" is a link you can paste to a teammate.
  // `null` — not `[]` — is the default, so "the param is absent" and "the bar
  // is explicitly empty" stay distinguishable. `useUrlState` drops a param whose
  // value equals its default, so an `[]` default made emptying the bar
  // indistinguishable from never having touched it, and the legacy fallback
  // below resurrected the pill the user had just removed.
  const [rawFilters, setRawFilters] = useUrlState<Filter[] | null>('filters', null, {
    cleanOnPathname: '/lore',
  });

  // The pre-filter-bar `?tags=` param. Still read (never written) so links
  // shared before this shipped — in PRs, Slack, and `lorekit link` output —
  // still land on the filter they name.
  const [legacyTags] = useUrlState<string[]>('tags', NO_TAGS, {
    cleanOnPathname: '/lore',
  });

  // Both params are user-editable text, so they can arrive as anything JSON can
  // express. Normalizing once here means every consumer below (the query, the
  // pills, the empty-state copy) reads a real `Filter[]`. An explicit
  // `?filters=` wins over the legacy shorthand — including when it is empty,
  // which is what makes removing the last pill on a `?tags=` link stick.
  const filters = useMemo(() => resolveFilters(rawFilters, legacyTags), [rawFilters, legacyTags]);

  // Every write goes through here so the "explicitly empty" marker is applied
  // in one place rather than at each of the four call sites below.
  const setFilters = useCallback(
    (next: Filter[]) => setRawFilters(filtersParamValue(next, legacyTags)),
    [setRawFilters, legacyTags],
  );

  // Which dimension the menu should open at, set by a pill's value segment.
  // Ephemeral — a request, not state worth sharing, so never in the URL.
  const [editingField, setEditingField] = useState<FilterField | null>(null);

  // The desktop and mobile layouts are BOTH mounted — the breakpoint split
  // below is CSS (`hidden md:flex` / `flex md:hidden`), not a conditional
  // render — so both `ControlRow`s hold a live `FilterMenu`. An `editingField`
  // handed to both opens both: each menu's effect runs in the same commit, so
  // the first one's `onOpenAtFieldHandled` has not cleared the request by the
  // time the second reads it, and the mobile `BottomSheet` portals to
  // `document.body`, which escapes its `md:hidden` ancestor and appears on
  // desktop. The request therefore goes to the variant that is actually
  // visible, and only that one; `useIsMobile` is JS for the reason
  // `useMediaQuery` documents — a `md:` class cannot gate a prop.
  const isMobile = useIsMobile();

  // URL-backed view mode so a shared link lands on the right tab.
  const [view, setView] = useUrlState<ViewMode>('view', 'scope');

  // Local-only: mobile accordion state. Ephemeral UI — not shareable, not
  // persisted. Putting this in URL state would pollute every share link and
  // fire a router.replace on every tap. Starts CLOSED so the phone layout opens
  // on the memories themselves — the scope tree is a filter, not the content,
  // and expanding it by default pushed the first card below the fold. The
  // collapsed header still shows the active scope, so nothing is hidden.
  const [scopePanelOpen, setScopePanelOpen] = useState(false);

  // Local-only: heatmap panel collapse. Ephemeral UI — not shareable.
  const [heatmapOpen, setHeatmapOpen] = useState(true);

  // URL-backed Status — scoped to /lore. Defaults to `null` (param absent), not
  // to 'active', for the reason `filters` defaults to null: absent has to be
  // distinguishable from an explicit choice, because an absent `status` falls
  // back to the legacy `archived` flag and an explicit one overrides it.
  const [rawStatus, setRawStatus] = useUrlState<MemoryStatus | null>('status', null, {
    cleanOnPathname: '/lore',
  });

  // The superseded boolean. Still READ so `?archived=true` links in PRs, Slack
  // and `lorekit link --archived` output keep resolving to the archived view —
  // the same treatment the legacy `?tags=` shorthand gets. Never written.
  const [legacyArchived] = useUrlState<boolean>('archived', false, {
    cleanOnPathname: '/lore',
  });

  const status = resolveStatus(rawStatus, legacyArchived);
  const showArchived = isArchivedView(status);

  // Paginated lesson list — server-side filtered by scope / search / range / status.
  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMemories({
    scope: selectedScope,
    search: committedSearch,
    range,
    filters,
    showArchived,
    expiringWithinDays: expiringWithinDays(status),
  });

  // Facet catalog for the menu (see `useFacetCatalog`) — its own endpoint query,
  // never derived from the loaded pages, so the menu's options can't shrink to
  // whatever happens to be loaded. Passing `filters` makes its counts drill down:
  // pick one filter and the other dimensions narrow to what selecting each would
  // yield, while the endpoint self-excludes each dimension so you can still widen
  // or switch within it. `selectedScope` scopes the counts to match the list —
  // without it a scoped view would show global counts and overstate the yield.
  // Archived-aware — the archived view is a different population with its own counts.
  const { data: facets } = useFacetCatalog(showArchived, filters, selectedScope);

  const lessons = useMemo(
    () => data?.pages.flatMap((page) => page.rows) ?? [],
    [data],
  );

  // Unique orgs present in the loaded lesson pages, for the ownership filter
  // chips — recomputed only when the underlying lessons change.
  const orgsInView = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const l of lessons) {
      if (l.org && !seen.has(l.org.id)) seen.set(l.org.id, l.org);
    }
    return Array.from(seen.values());
  }, [lessons]);

  // Ownership is the one filter with no server-side param — scope / search /
  // range / archived are already applied by `useMemories`, so this is a pure
  // client-side narrowing of the loaded pages by owner (Personal vs a given
  // org). `filterByOwnership` is the shared, unit-tested predicate.
  const filteredLessons = useMemo(
    () => filterByOwnership(lessons, ownerFilter),
    [lessons, ownerFilter],
  );

  const isFiltered =
    search.trim() !== '' ||
    range !== null ||
    status !== DEFAULT_STATUS ||
    ownerFilter !== 'all' ||
    filters.length > 0;

  // Every filter mutation closes the lesson sidebar for one reason: the open
  // lesson may not survive the new predicate, and a detail panel describing a
  // memory that is no longer in the list behind it is a lie about what you are
  // looking at.
  function handleToggleFilterValue(field: FilterField, value: string) {
    setFilters(toggleFilterValue(filters, field, value));
    closeLesson();
  }

  function handleOperatorChange(field: FilterField, operator: FilterOperator) {
    setFilters(setFilterOperator(filters, field, operator));
    closeLesson();
  }

  function handleRemoveFilter(field: FilterField) {
    setFilters(removeFilter(filters, field));
    closeLesson();
  }

  function handleClearFilters() {
    setFilters(NO_FILTERS);
    closeLesson();
  }

  function handleStatusChange(next: MemoryStatus) {
    // `statusParamValue` decides whether the param is written or dropped — it
    // has to be written even for the default when a legacy `archived=true` is
    // still in the URL, or selecting Active would silently undo itself on the
    // next reload.
    setRawStatus(statusParamValue(next, legacyArchived));
    // Close the sidebar — the open lesson may not exist in the other population.
    closeLesson();
  }

  function handleScopeSelect(scope: string | null) {
    startTransition(() => {
      setSelectedScope(scope);
      // Close the sidebar when switching scope — the previous lesson may not
      // be present in the new scope.
      closeLesson();
      setScopePanelOpen(false);
    });
  }

  function handleLessonClick(lesson: LessonEntry) {
    if (openLesson?.key === lesson.key && openLesson?.scope === lesson.scope) {
      closeLesson();
    } else {
      // Pass the full lesson object so the sidebar can render immediately
      // without a lookup — critical for archived lessons which aren't in the
      // active useLoreData cache.
      openLessonById({ scope: lesson.scope, key: lesson.key }, lesson);
    }
  }

  // Heatmap day-click: two-click range anchor → extend → reset, matching the
  // original activity page behaviour.
  function handleHeatmapDayClick(day: string) {
    if (range && range.from === range.to) {
      const anchor = range.from;
      setRange(day >= anchor ? { from: anchor, to: day } : { from: day, to: anchor });
    } else {
      setRange({ from: day, to: day });
    }
  }

  const selectedScopeLabel =
    selectedScope === null
      ? 'All scopes'
      : (scopes.find((s) => s.scope === selectedScope)?.label ?? selectedScope);

  const totalCount = scopes.reduce((sum, s) => sum + s.count, 0);

  const isLessonSelected = (lesson: LessonEntry) =>
    openLesson?.key === lesson.key && openLesson?.scope === lesson.scope;

  // Shared "Load more" / "all loaded" control — identical for both views so the
  // pagination affordance never differs between the scope list and the feed.
  const loadMore = (
    <div className="flex justify-center pt-2 pb-1">
      {hasNextPage ? (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 py-1.5 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] disabled:opacity-60"
        >
          {isFetchingNextPage && (
            <Loader2
              className={`size-3.5 ${reduceMotion ? '' : 'animate-spin'}`}
              aria-hidden
            />
          )}
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : (
        <p className="text-[10px] text-[var(--color-content-tertiary)]">All memories loaded</p>
      )}
    </div>
  );

  // Shared results renderer for BOTH tabs. Loading / error / empty are handled
  // once here; only the populated body differs — a flat card list ("scope") vs
  // date-grouped feed rows ("time"). Both consume the SAME `filteredLessons`
  // (server-filtered by scope/search/range/archived, then owner-narrowed
  // client-side), so every filter applies identically across tabs.
  //
  // This is a plain function that is CALLED, not a nested component rendered as
  // `<Results />`. A nested component would get a fresh type identity on every
  // parent render, so React would unmount and remount the entire list each time
  // any filter/search/transition state changed — replaying every card's enter
  // animation even when the same cards remain. Inlining the returned JSX keeps
  // each keyed card mounted across renders, so only genuinely-new cards animate.
  const renderResults = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col gap-2 p-3" aria-label="Loading memories" role="status">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      );
    }

    if (isError) {
      return (
        <div className="flex items-center justify-center p-8">
          <p className="text-sm text-[var(--color-content-secondary)]">Failed to load memories. Please refresh.</p>
        </div>
      );
    }

    // Empty state only when nothing is left to show AND nothing more to load —
    // the ownership filter is client-side over the loaded pages, so an empty
    // `filteredLessons` with `hasNextPage` still true means "keep loading",
    // not "no matches".
    if (filteredLessons.length === 0 && !hasNextPage) {
      return (
        <EmptyState
          icon={EMPTY_STATE_ICONS[status]}
          title={
            status === 'archived'
              ? 'No archived memories'
              : // An empty EXPIRING view is good news, not a failed search, so it
                // gets its own copy rather than falling through to "no matches".
                // Reading "No matching memories" when the honest answer is
                // "nothing is about to be lost" would send someone hunting for a
                // filter to remove.
                status === 'expiring'
                ? 'Nothing expiring soon'
                : isFiltered
                  ? 'No matching memories'
                  : 'No memories in this scope'
          }
          description={
            status === 'archived'
              ? 'Archive a memory from its detail panel to see it here.'
              : status === 'expiring'
                ? `No live memory in this view runs out within ${EXPIRING_WITHIN_DAYS} days.`
                : isFiltered
                  ? // Filters AND together, so the most likely cause of an empty
                    // list is one condition too many — name that before search
                    // terms and dates, which the user can already see.
                    filters.length > 1
                    ? 'No memory satisfies every filter — try removing one.'
                    : 'Try a different search term, filter, or date range.'
                  : 'Memories will appear here once your agents start writing.'
          }
        />
      );
    }

    if (view === 'time') {
      return (
        <div className="flex flex-col gap-1">
          <ActivityFeed
            lessons={filteredLessons}
            isSelected={isLessonSelected}
            onSelect={handleLessonClick}
          />
          {loadMore}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-2" role="list" aria-label="Memories">
        {filteredLessons.map((lesson, i) => (
          <div key={`${lesson.scope}::${lesson.key}`} role="listitem">
            <LessonCard
              lesson={lesson}
              selected={isLessonSelected(lesson)}
              onClick={() => handleLessonClick(lesson)}
              index={i}
            />
          </div>
        ))}

        {loadMore}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Screen-reader-only status announcements. */}
      <p role="status" aria-live="polite" className="sr-only">
        {isLoading
          ? 'Loading memories'
          : isFetchingNextPage
            ? 'Loading more memories'
            : `${filteredLessons.length} memor${filteredLessons.length === 1 ? 'y' : 'ies'} loaded`}
      </p>

      {/* ── Heatmap panel (collapsible) ─────────────────────────────────── */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]">
        <button
          type="button"
          onClick={() => setHeatmapOpen((v) => !v)}
          aria-expanded={heatmapOpen}
          className="flex w-full min-h-11 items-center justify-between gap-4 px-5 py-3"
        >
          <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
            Memories written — last 26 weeks
          </p>
          {heatmapOpen ? (
            <ChevronUp className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
          )}
        </button>
        {heatmapOpen && (
          <div className="px-5 pb-5">
            <ContributionHeatmap
              data={heatmapData}
              weeks={26}
              selectedRange={range}
              onSelectDate={handleHeatmapDayClick}
            />
          </div>
        )}
      </div>

      {/* ── View-mode tabs ───────────────────────────────────────────────── */}
      <div
        className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-1"
        role="tablist"
        aria-label="Explorer view"
      >
        {([
          { id: 'scope' as ViewMode, label: 'Browse by scope', icon: LayoutGrid },
          { id: 'time' as ViewMode, label: 'Browse by time', icon: List },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={[
              'flex flex-1 min-h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-all duration-150',
              view === id
                ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
            ].join(' ')}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {/* ── Results (shared chrome for both tabs) ───────────────────────────
          Scope tree + filter bar (search / date / archived) + owner bar are the
          SAME for "Browse by scope" and "Browse by time"; only the body inside
          `renderResults()` differs (card list vs date-grouped feed). Lifting
          the chrome out of the two views is what makes the tabs read as one
          page and keeps every filter — including Owner — active across both. */}

      {/* Desktop: side-by-side panels */}
      <div className="hidden md:flex h-full gap-0 overflow-hidden rounded-xl border border-[var(--color-border)]">
        <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-raised)]">
          <div className="border-b border-[var(--color-border)] px-3 py-2.5">
            <p className="text-xs font-medium text-[var(--color-content-tertiary)]">Scopes</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {scopes.length > 0 ? (
              <ScopeTree
                nodes={scopes}
                selected={selectedScope}
                onSelect={handleScopeSelect}
                totalCount={totalCount}
              />
            ) : (
              <EmptyState icon={BookOpen} title="No scopes yet" description="Run an agent to create your first memory." />
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">
          <ControlRow
            variant="desktop"
            search={search}
            onSearchChange={setSearch}
            facets={facets ?? []}
            filters={filters}
            onToggleFilterValue={handleToggleFilterValue}
            editingField={isMobile ? null : editingField}
            onEditField={setEditingField}
            range={range}
            onRangeChange={setRange}
            status={status}
            onStatusChange={handleStatusChange}
          />

          <FilterPillRow
            filters={filters}
            onOperatorChange={handleOperatorChange}
            onRemove={handleRemoveFilter}
            onClearAll={handleClearFilters}
            onEditField={setEditingField}
          />

          <OwnershipFilterBar orgs={orgsInView} value={ownerFilter} onChange={setOwnerFilter} />

          <div className="flex-1 overflow-y-auto p-3">
            {renderResults()}
          </div>
        </div>
      </div>

      {/* Mobile: stacked layout — pb-6 so the last card and "Load more" button
          clear the bottom edge of the scroll container. */}
      <div className="flex md:hidden flex-col gap-3 pb-6">
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden">
          <button
            type="button"
            onClick={() => setScopePanelOpen((v) => !v)}
            aria-expanded={scopePanelOpen}
            className="flex w-full min-h-11 items-center justify-between gap-2 px-4 py-2.5 text-sm text-[var(--color-content-primary)]"
          >
            <span className="font-medium">
              Scope: <span className="text-[var(--color-accent)] font-mono text-xs">{selectedScopeLabel}</span>
            </span>
            <ChevronDown
              className={['size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200', scopePanelOpen ? 'rotate-180' : ''].join(' ')}
              aria-hidden
            />
          </button>
          {scopePanelOpen && (
            <div className="border-t border-[var(--color-border)] max-h-52 overflow-y-auto">
              <ScopeTree
                nodes={scopes}
                selected={selectedScope}
                onSelect={handleScopeSelect}
                totalCount={totalCount}
              />
            </div>
          )}
        </div>

        <ControlRow
          variant="mobile"
          search={search}
          onSearchChange={setSearch}
          facets={facets ?? []}
          filters={filters}
          onToggleFilterValue={handleToggleFilterValue}
          editingField={isMobile ? editingField : null}
          onEditField={setEditingField}
          range={range}
          onRangeChange={setRange}
          status={status}
          onStatusChange={handleStatusChange}
        />

        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] empty:hidden">
          <FilterPillRow
            filters={filters}
            onOperatorChange={handleOperatorChange}
            onRemove={handleRemoveFilter}
            onClearAll={handleClearFilters}
            onEditField={setEditingField}
          />
        </div>

        <OwnershipFilterBar orgs={orgsInView} value={ownerFilter} onChange={setOwnerFilter} />

        <div>
          {renderResults()}
        </div>
      </div>
    </div>
  );
}
