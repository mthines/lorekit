'use client';

import { useState, useMemo, useTransition } from 'react';
import { Search, BookOpen, ChevronDown } from 'lucide-react';
import { ScopeTree, type ScopeNode } from './ScopeTree';
import { LessonCard, type LessonEntry } from './LessonCard';
import { LessonDetailSheet } from './LessonDetailSheet';
import { EmptyState } from '@/components/ui/EmptyState';

interface LoreExplorerProps {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
}

export function LoreExplorer({ scopes, lessons }: LoreExplorerProps) {
  const [selectedScope, setSelectedScope] = useState<string | null>(
    scopes[0]?.scope ?? null,
  );
  const [selectedLesson, setSelectedLesson] = useState<LessonEntry | null>(null);
  const [query, setQuery] = useState('');
  const [, startTransition] = useTransition();
  const [scopePanelOpen, setScopePanelOpen] = useState(true);

  const filteredLessons = useMemo(() => {
    const scopeLessons = selectedScope
      ? lessons.filter((l) => l.scope === selectedScope)
      : lessons;

    if (!query.trim()) return scopeLessons;

    const q = query.toLowerCase();
    return scopeLessons.filter(
      (l) =>
        l.key.toLowerCase().includes(q) ||
        l.value.toLowerCase().includes(q) ||
        l.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [lessons, selectedScope, query]);

  function handleScopeSelect(scope: string) {
    startTransition(() => {
      setSelectedScope(scope);
      setSelectedLesson(null);
      setScopePanelOpen(false);
    });
  }

  const selectedScopeLabel =
    scopes.find((s) => s.scope === selectedScope)?.label ?? selectedScope ?? 'All scopes';

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
              <ScopeTree nodes={scopes} selected={selectedScope} onSelect={handleScopeSelect} />
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
                      selected={selectedLesson?.key === lesson.key && selectedLesson?.scope === lesson.scope}
                      onClick={() => setSelectedLesson(lesson)}
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
              <ScopeTree nodes={scopes} selected={selectedScope} onSelect={handleScopeSelect} />
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
                    selected={selectedLesson?.key === lesson.key && selectedLesson?.scope === lesson.scope}
                    onClick={() => setSelectedLesson(lesson)}
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

      <LessonDetailSheet lesson={selectedLesson} onClose={() => setSelectedLesson(null)} />
    </>
  );
}
