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
 * - `range` param:    date range, shareable. Scoped to /lore. Shared by the
 *   heatmap click, scope view, and feed view — one param drives all three.
 * - `view` param:     'scope' | 'time'. Persisted in URL so a shared link
 *   lands on the correct tab.
 * - `scopePanelOpen`: local useState — ephemeral mobile accordion, NOT in URL.
 * - `heatmapOpen`:    local useState — ephemeral panel collapse, NOT in URL.
 *
 * ## SSR note
 * Uses `useSearchParams()` via `useUrlState`. Must be wrapped in <Suspense>.
 */

import { useMemo, useTransition, useState } from 'react';
import { Search, BookOpen, ChevronDown, ChevronUp, Loader2, List, LayoutGrid, Archive } from 'lucide-react';
import { ScopeTree, type ScopeNode } from './ScopeTree';
import { LessonCard } from './LessonCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useDebouncedUrlState } from '@/lib/hooks/useDebouncedUrlState';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { DateRangePicker, type DateRange } from '@/components/ui/DateRangePicker';
import { useMemories } from '@/lib/queries/lore';
import { useReducedMotion } from 'motion/react';
import type { LessonEntry } from './LessonCard';
import { ContributionHeatmap } from '@/components/activity/ContributionHeatmap';
import { ActivityFeed, type ActivityEvent } from '@/components/activity/ActivityFeed';
import { filterByOwnership, type OwnerFilter } from '@/lib/org-ui';

type ViewMode = 'scope' | 'time';

// ── Ownership filter bar ──────────────────────────────────────────────────────
// "All · Personal · {org}" per ux-design §4 — only rendered when at least one
// org-owned lesson is in view (nothing to filter by ownership otherwise).
// Single-select, so it uses radiogroup/radio semantics (aria-checked), not the
// toggle-button aria-pressed shape.

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

  const chips: { key: string; label: string; filter: OwnerFilter }[] = [
    { key: 'all', label: 'All', filter: 'all' },
    { key: 'personal', label: 'Personal', filter: 'personal' },
    ...orgs.map((org) => ({ key: org.id, label: org.name, filter: { orgId: org.id } as OwnerFilter })),
  ];

  return (
    <div role="radiogroup" aria-label="Filter by ownership" className="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          role="radio"
          onClick={() => onChange(chip.filter)}
          aria-checked={isActive(chip.filter)}
          className={[
            'flex min-h-9 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150',
            isActive(chip.filter)
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
          ].join(' ')}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

interface LoreExplorerProps {
  scopes: ScopeNode[];
  heatmapData: { date: string; count: number }[];
  feedEvents: ActivityEvent[];
}

export function LoreExplorer({ scopes, heatmapData, feedEvents }: LoreExplorerProps) {
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

  // URL-backed view mode so a shared link lands on the right tab.
  const [view, setView] = useUrlState<ViewMode>('view', 'scope');

  // Local-only: mobile accordion state. Ephemeral UI — not shareable, not
  // persisted. Putting this in URL state would pollute every share link and
  // fire a router.replace on every tap.
  const [scopePanelOpen, setScopePanelOpen] = useState(true);

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
  } = useMemories({ scope: selectedScope, search: committedSearch, range, showArchived });

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
    search.trim() !== '' || range !== null || showArchived || ownerFilter !== 'all';

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

  // Shared lesson list renderer (scope view only).
  function LessonList() {
    if (isLoading) {
      return (
        <div className="flex flex-col gap-2 p-3" aria-label="Loading lessons" role="status">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      );
    }

    if (isError) {
      return (
        <div className="flex items-center justify-center p-8">
          <p className="text-sm text-[var(--color-content-secondary)]">Failed to load lessons. Please refresh.</p>
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
                ? 'No matching lessons'
                : 'No lessons in this scope'
          }
          description={
            showArchived
              ? 'Archive a memory from its detail panel to see it here.'
              : isFiltered
                ? 'Try a different search term or date range.'
                : 'Lessons will appear here once your agents start writing.'
          }
        />
      );
    }

    return (
      <div className="flex flex-col gap-2">
        {filteredLessons.map((lesson, i) => (
          <div key={`${lesson.scope}::${lesson.key}`} role="listitem">
            <LessonCard
              lesson={lesson}
              selected={openLesson?.key === lesson.key && openLesson?.scope === lesson.scope}
              onClick={() => handleLessonClick(lesson)}
              index={i}
            />
          </div>
        ))}

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
            <p className="text-[10px] text-[var(--color-content-tertiary)]">All lessons loaded</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Screen-reader-only status announcements. */}
      <p role="status" aria-live="polite" className="sr-only">
        {isLoading
          ? 'Loading lessons'
          : isFetchingNextPage
            ? 'Loading more lessons'
            : `${filteredLessons.length} lesson${filteredLessons.length === 1 ? '' : 's'} loaded`}
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
            Lessons written — last 26 weeks
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

      {/* ── Scope view ──────────────────────────────────────────────────── */}
      {view === 'scope' && (
        <>
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
                  <EmptyState icon={BookOpen} title="No scopes yet" description="Run an agent to create your first lesson." />
                )}
              </div>
            </div>

            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border)] p-3">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]" aria-hidden />
                  <input
                    type="search"
                    placeholder="Search lessons…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search lessons"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-2 pl-8 pr-3 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-150"
                  />
                </div>
                <DateRangePicker value={range} onChange={setRange} className="shrink-0" />
                <button
                  type="button"
                  onClick={() => {
                    setShowArchived(!showArchived);
                    closeLesson();
                  }}
                  aria-pressed={showArchived}
                  aria-label={showArchived ? 'Showing archived memories — click to show active' : 'Show archived memories'}
                  title={showArchived ? 'Showing archived' : 'Show archived'}
                  className={[
                    'flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-150',
                    showArchived
                      ? 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                      : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)] hover:border-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
                  ].join(' ')}
                >
                  <Archive className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">Archived</span>
                </button>
              </div>

              <OwnershipFilterBar orgs={orgsInView} value={ownerFilter} onChange={setOwnerFilter} />

              <div className="flex-1 overflow-y-auto p-3" role="list" aria-label="Lessons">
                <LessonList />
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

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]" aria-hidden />
                <input
                  type="search"
                  placeholder="Search lessons…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search lessons"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] py-2 pl-8 pr-3 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-150"
                />
              </div>
              <DateRangePicker value={range} onChange={setRange} className="shrink-0" />
              <button
                type="button"
                onClick={() => {
                  setShowArchived(!showArchived);
                  closeLesson();
                }}
                aria-pressed={showArchived}
                aria-label={showArchived ? 'Showing archived memories — click to show active' : 'Show archived memories'}
                className={[
                  'flex min-h-9 shrink-0 items-center justify-center rounded-lg border p-2 transition-all duration-150',
                  showArchived
                    ? 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]',
                ].join(' ')}
              >
                <Archive className="size-4" aria-hidden />
              </button>
            </div>

            <OwnershipFilterBar orgs={orgsInView} value={ownerFilter} onChange={setOwnerFilter} />

            <div role="list" aria-label="Lessons">
              <LessonList />
            </div>
          </div>
        </>
      )}

      {/* ── Time view (former /activity) ────────────────────────────────── */}
      {view === 'time' && (
        <ActivityFeed events={feedEvents} range={range} onRangeChange={setRange} />
      )}
    </div>
  );
}
