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
 * - `scopePanelOpen`: local useState — ephemeral mobile accordion, NOT in URL.
 *   Defaults to closed so the phone layout leads with the memories.
 * - `heatmapOpen`:    local useState — ephemeral panel collapse, NOT in URL.
 *
 * ## SSR note
 * Uses `useSearchParams()` via `useUrlState`. Must be wrapped in <Suspense>.
 */

import { useMemo, useTransition, useState } from 'react';
import { Search, BookOpen, ChevronDown, ChevronUp, Loader2, List, LayoutGrid, Archive, User, Building2, Users } from 'lucide-react';
import { ScopeTree, type ScopeNode } from './ScopeTree';
import { LessonCard } from './LessonCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useDebouncedUrlState } from '@/lib/hooks/useDebouncedUrlState';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { DateRangePicker, type DateRange } from '@/components/ui/DateRangePicker';
import { useMemories, useTagCatalog } from '@/lib/queries/lore';
import { normalizeTags, toggleTag, type TagCount } from '@/lib/tag-filter';
import { LabelFilter } from './LabelFilter';
import { useReducedMotion } from 'motion/react';
import type { LessonEntry } from './LessonCard';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed } from '@/components/activity/ActivityFeed';
import { filterByOwnership, type OwnerFilter } from '@/lib/org-ui';

type ViewMode = 'scope' | 'time';

// Module-scoped so the reference is stable across renders — `useUrlState`
// documents that mutable defaults must be memoized at the call site.
const NO_TAGS: string[] = [];

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

// ── Filter bar (search + labels + date + archived) ────────────────────────────
// Shared by both tabs and both breakpoints. `variant` carries the only two
// differences between the desktop and mobile renders: the desktop bar sits in a
// bordered header (`border-b`/padding), uses smaller type + the page `bg`, and
// shows text labels + hover affordances; the mobile bar is a bare row with
// icon-only toggles on the raised `bg`. Everything else — the search input, the
// label picker, the date picker, the toggle behaviour — is identical, so it
// lives here once instead of near-verbatim in each breakpoint branch.
//
// The label picker is a popover rather than an expanded chip row: labels are
// the one dimension here that grows without bound, so an inline bar would push
// the results it filters below the fold. See `LabelFilter`.

function FilterBar({
  variant,
  search,
  onSearchChange,
  tagCatalog,
  selectedTags,
  onToggleTag,
  onClearTags,
  range,
  onRangeChange,
  showArchived,
  onToggleArchived,
}: {
  variant: 'desktop' | 'mobile';
  search: string;
  onSearchChange: (value: string) => void;
  tagCatalog: TagCount[];
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  range: DateRange | null;
  onRangeChange: (range: DateRange | null) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
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
      <LabelFilter
        catalog={tagCatalog}
        selected={selectedTags}
        onToggle={onToggleTag}
        onClear={onClearTags}
        variant={variant}
        className="shrink-0"
      />
      <DateRangePicker value={range} onChange={onRangeChange} className="shrink-0" />
      <button
        type="button"
        onClick={onToggleArchived}
        aria-pressed={showArchived}
        aria-label={showArchived ? 'Showing archived memories — click to show active' : 'Show archived memories'}
        title={desktop ? (showArchived ? 'Showing archived' : 'Show archived') : undefined}
        className={[
          'flex min-h-9 shrink-0 items-center rounded-lg border transition-all duration-150',
          desktop ? 'gap-1.5 px-2.5 py-1.5 text-xs font-medium' : 'justify-center p-2',
          showArchived
            ? 'border-amber-400/40 bg-amber-400/10 text-amber-400'
            : `border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]${
                desktop ? ' hover:border-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]' : ''
              }`,
        ].join(' ')}
      >
        <Archive className={desktop ? 'size-3.5' : 'size-4'} aria-hidden />
        {desktop && <span className="hidden sm:inline">Archived</span>}
      </button>
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

  // URL-backed label selection — server-side filtered (AND across labels), so
  // it belongs in the query, not in a client-side narrowing like `owner`.
  const [rawSelectedTags, setSelectedTags] = useUrlState<string[]>('tags', NO_TAGS, {
    cleanOnPathname: '/lore',
  });

  // The `tags` param is user-editable text, so it can arrive as anything JSON
  // can express. Normalizing once here means every consumer below (the query,
  // the chips, the empty-state copy) reads a real `string[]`.
  const selectedTags = useMemo(() => normalizeTags(rawSelectedTags), [rawSelectedTags]);

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

  // URL-backed archived toggle — scoped to /lore.
  const [showArchived, setShowArchived] = useUrlState<boolean>('archived', false, {
    cleanOnPathname: '/lore',
  });

  // Paginated lesson list — server-side filtered by scope / search / range / archived.
  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMemories({ scope: selectedScope, search: committedSearch, range, tags: selectedTags, showArchived });

  // Filter-independent label catalog (see `useTagCatalog`) — the chips must not
  // shrink to whatever the current filter happens to have loaded.
  // Archived-aware: the archived view is a different population, so it gets
  // its own counts rather than the active view's.
  const { data: tagCatalog } = useTagCatalog(showArchived);

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
    showArchived ||
    ownerFilter !== 'all' ||
    selectedTags.length > 0;

  function handleToggleTag(tag: string) {
    setSelectedTags((prev) => toggleTag(prev, tag));
    // Close the sidebar — the open lesson may not carry the new label set.
    closeLesson();
  }

  function handleClearTags() {
    setSelectedTags(NO_TAGS);
    closeLesson();
  }

  function handleToggleArchived() {
    setShowArchived(!showArchived);
    // Close the sidebar — the open lesson may not exist in the other list.
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
          icon={showArchived ? Archive : BookOpen}
          title={
            showArchived
              ? 'No archived memories'
              : isFiltered
                ? 'No matching memories'
                : 'No memories in this scope'
          }
          description={
            showArchived
              ? 'Archive a memory from its detail panel to see it here.'
              : isFiltered
                ? selectedTags.length > 1
                  ? 'No memory carries all of the selected labels — try removing one.'
                  : 'Try a different search term, label, or date range.'
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
          <FilterBar
            variant="desktop"
            search={search}
            onSearchChange={setSearch}
            tagCatalog={tagCatalog ?? []}
            selectedTags={selectedTags}
            onToggleTag={handleToggleTag}
            onClearTags={handleClearTags}
            range={range}
            onRangeChange={setRange}
            showArchived={showArchived}
            onToggleArchived={handleToggleArchived}
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

        <FilterBar
          variant="mobile"
          search={search}
          onSearchChange={setSearch}
          tagCatalog={tagCatalog ?? []}
          selectedTags={selectedTags}
          onToggleTag={handleToggleTag}
          onClearTags={handleClearTags}
          range={range}
          onRangeChange={setRange}
          showArchived={showArchived}
          onToggleArchived={handleToggleArchived}
        />

        <OwnershipFilterBar orgs={orgsInView} value={ownerFilter} onChange={setOwnerFilter} />

        <div>
          {renderResults()}
        </div>
      </div>
    </div>
  );
}
