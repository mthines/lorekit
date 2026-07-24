'use client';

/**
 * LoreExplorer
 *
 * Browseable two-panel layout (scope tree + lesson list) for the Lore page.
 *
 * ## URL state strategy
 * - `scope` param:   which scope is selected. Shareable, survives refresh.
 * - `q` param:       the active search query. Survives refresh.
 * - `scopePanelOpen`: local useState — ephemeral accordion state, NOT in URL.
 *   Putting accordion visibility in the URL clutters the address bar and the
 *   share link with low-value UI state. It also fires a router.replace on every
 *   mobile accordion tap, which is expensive and unnecessary.
 *
 * ## SSR note
 * This component uses `useUrlState` which calls `useSearchParams()`. It must be
 * wrapped in a <Suspense> boundary (via the dashboard layout). On the server,
 * `scope` and `q` default to null / '' and the first scope is shown; on the
 * client, the real URL values hydrate without mismatch.
 *
 * ## Optimistic state
 * `useUrlState` provides immediate UI feedback on scope/query changes via its
 * internal optimistic layer. Switching scope feels instant; the URL update
 * happens in the background.
 */

import { useMemo, useTransition, useState } from 'react';
import { Search, BookOpen, ChevronDown } from 'lucide-react';
import { ScopeTree, type ScopeNode } from './ScopeTree';
import { LessonCard, type LessonEntry } from './LessonCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';

interface LoreExplorerProps {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
}

export function LoreExplorer({ scopes, lessons }: LoreExplorerProps) {
  const { openLesson, openLessonById, closeLesson } = useMemorySidebar();
  const [, startTransition] = useTransition();

  // URL-backed: scope selection and search query survive refreshes and are
  // shareable. The optimistic layer in useUrlState ensures immediate feedback.
  const [selectedScope, setSelectedScope] = useUrlState<string | null>('scope', null);
  const [query, setQuery] = useUrlState<string>('q', '');

  // Local-only: mobile accordion state. Ephemeral UI — not shareable, not
  // persisted. Putting this in URL state would pollute every share link and
  // fire a router.replace on every tap.
  const [scopePanelOpen, setScopePanelOpen] = useState(true);

  // When no scope is stored in the URL, fall back to the first available scope.
  // We do NOT write this back to the URL so that clean URLs stay clean (i.e.
  // navigating to /lore without a ?scope= shows all lessons in the first scope
  // without adding a param to the URL).
  const effectiveScope = selectedScope ?? scopes[0]?.scope ?? null;

  const filteredLessons = useMemo(() => {
    const scopeLessons = effectiveScope
      ? lessons.filter((l) => l.scope === effectiveScope)
      : lessons;

    if (!query.trim()) return scopeLessons;

    const q = query.toLowerCase();
    return scopeLessons.filter(
      (l) =>
        l.key.toLowerCase().includes(q) ||
        l.value.toLowerCase().includes(q) ||
        l.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [lessons, effectiveScope, query]);

  function handleScopeSelect(scope: string) {
    startTransition(() => {
      setSelectedScope(scope);
      // Close the sidebar when switching scope – the previous lesson may not
      // exist in the new scope.
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
    scopes.find((s) => s.scope === effectiveScope)?.label ?? effectiveScope ?? 'All scopes';

  return (
    <>
      {/* Desktop: side-by-side panels */}
      <div className="hidden md:flex h-full gap-0 overflow-hidden rounded-xl border border-[var(--color-border)]">
        <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-raised)]">
          <div className="border-b border-[var(--color-border)] px-3 py-2.5">
            <p className="text-xs font-medium text-[var(--color-content-tertiary)]">Scopes</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {scopes.length > 0 ? (
              <ScopeTree nodes={scopes} selected={effectiveScope} onSelect={handleScopeSelect} />
            ) : (
              <EmptyState icon={BookOpen} title="No scopes yet" description="Run an agent to create your first lesson." />
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-[var(--color-border)] p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]" aria-hidden />
              <input
                type="search"
                placeholder="Search lessons…"
                value={query}
                onChange={(e) => startTransition(() => setQuery(e.target.value))}
                aria-label="Search lessons"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-2 pl-8 pr-3 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-150"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3" role="list" aria-label="Lessons">
            {filteredLessons.length > 0 ? (
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
              </div>
            ) : (
              <EmptyState
                icon={BookOpen}
                title={query ? 'No matching lessons' : 'No lessons in this scope'}
                description={query ? 'Try a different search term.' : 'Lessons will appear here once your agents start writing.'}
              />
            )}
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
          {scopePanelOpen && scopes.length > 0 && (
            <div className="border-t border-[var(--color-border)] max-h-52 overflow-y-auto">
              <ScopeTree nodes={scopes} selected={effectiveScope} onSelect={handleScopeSelect} />
            </div>
          )}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]" aria-hidden />
          <input
            type="search"
            placeholder="Search lessons…"
            value={query}
            onChange={(e) => startTransition(() => setQuery(e.target.value))}
            aria-label="Search lessons"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] py-2 pl-8 pr-3 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-150"
          />
        </div>

        <div role="list" aria-label="Lessons">
          {filteredLessons.length > 0 ? (
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
            </div>
          ) : (
            <EmptyState
              icon={BookOpen}
              title={query ? 'No matching lessons' : 'No lessons in this scope'}
              description={query ? 'Try a different search term.' : 'Lessons will appear here once your agents start writing.'}
            />
          )}
        </div>
      </div>
    </>
  );
}
