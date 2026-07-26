'use client';

/**
 * LoreExplorer
 *
 * Two-panel layout (scope tree + paginated lesson list) for the Lore page.
 * Lessons are fetched server-side with keyset pagination, mirroring the
 * AuditLogFeed pattern. Scope selection and search are URL-backed.
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
 * - `scope` param: selected scope (null → all scopes). Shareable.
 * - `q` param: search query, debounced write. Shareable.
 * - `range` param: date range, shareable. Scoped to /lore.
 * - `scopePanelOpen`: local useState — ephemeral mobile accordion, NOT in URL.
 *
 * ## SSR note
 * Uses `useSearchParams()` via `useUrlState`. Must be wrapped in <Suspense>.
 */

import { useMemo, useTransition, useState } from 'react';
import { Search, BookOpen, ChevronDown, Loader2 } from 'lucide-react';
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

interface LoreExplorerProps {
  scopes: ScopeNode[];
}

export function LoreExplorer({ scopes }: LoreExplorerProps) {
  const { openLesson, openLessonById, closeLesson } = useMemorySidebar();
  const [, startTransition] = useTransition();
  const reduceMotion = useReducedMotion();

  // URL-backed: null means "all scopes" (the new default). A discrete click
  // writes the URL immediately (no debounce). Scoped to /lore.
  const [selectedScope, setSelectedScope] = useUrlState<string | null>('scope', null, {
    cleanOnPathname: '/lore',
  });

  // Search is high-frequency input — the returned `query` is instantly
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

  // URL-backed date range, scoped to /lore.
  const [range, setRange] = useUrlState<DateRange | null>('range', null, {
    cleanOnPathname: '/lore',
  });

  // Local-only: mobile accordion state. Ephemeral — not shareable.
  const [scopePanelOpen, setScopePanelOpen] = useState(true);

  // Paginated lesson list — server-side filtered by scope / search / range.
  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMemories({ scope: selectedScope, search: committedSearch, range });

  const lessons = useMemo(
    () => data?.pages.flatMap((page) => page.rows) ?? [],
    [data],
  );

  const isFiltered = search.trim() !== '' || range !== null;

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
      openLessonById({ scope: lesson.scope, key: lesson.key });
    }
  }

  const selectedScopeLabel =
    selectedScope === null
      ? 'All scopes'
      : (scopes.find((s) => s.scope === selectedScope)?.label ?? selectedScope);

  const totalCount = scopes.reduce((sum, s) => sum + s.count, 0);

  // Shared lesson list renderer.
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

    if (lessons.length === 0) {
      return (
        <EmptyState
          icon={BookOpen}
          title={isFiltered ? 'No matching lessons' : 'No lessons in this scope'}
          description={isFiltered ? 'Try a different search term or date range.' : 'Lessons will appear here once your agents start writing.'}
        />
      );
    }

    return (
      <div className="flex flex-col gap-2">
        {lessons.map((lesson, i) => (
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
    <>
      {/* Screen-reader-only status announcements. */}
      <p role="status" aria-live="polite" className="sr-only">
        {isLoading
          ? 'Loading lessons'
          : isFetchingNextPage
            ? 'Loading more lessons'
            : `${lessons.length} lesson${lessons.length === 1 ? '' : 's'} loaded`}
      </p>

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
          </div>

          <div className="flex-1 overflow-y-auto p-3" role="list" aria-label="Lessons">
            <LessonList />
          </div>
        </div>
      </div>

      {/* Mobile: stacked layout */}
      <div className="flex md:hidden flex-col gap-3">
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden">
          <button
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
        </div>

        <div role="list" aria-label="Lessons">
          <LessonList />
        </div>
      </div>
    </>
  );
}
