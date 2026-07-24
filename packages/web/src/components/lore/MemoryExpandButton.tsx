'use client';

/**
 * MemoryExpandButton
 *
 * A compact widget that displays the count of loaded memories and opens the
 * memory detail sidebar when clicked on a specific lesson. It is intentionally
 * minimal — it delegates full lesson browsing to the Lore Explorer page.
 *
 * Place this in any page header or toolbar to surface recent memories without
 * navigating away. The sidebar state is persisted in URL so refreshing keeps
 * the selected lesson open.
 */

import { useMemo } from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useLoreData } from '@/lib/queries/lore';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import type { LessonEntry } from '@/components/lore/LessonCard';

interface MemoryExpandButtonProps {
  /**
   * Scope to highlight/show. When provided only lessons from this scope are
   * shown in the dropdown preview. Omit to show across all scopes.
   */
  scope?: string;
  /** Max number of recent lessons to preview in the dropdown. @default 5 */
  previewCount?: number;
  className?: string;
}

export function MemoryExpandButton({
  scope,
  previewCount = 5,
  className = '',
}: MemoryExpandButtonProps) {
  const { data, isLoading } = useLoreData();
  const { openLesson, openLessonById, closeLesson, isOpen } = useMemorySidebar();

  const lessons = useMemo<LessonEntry[]>(() => {
    if (!data?.lessons) return [];
    const base = scope ? data.lessons.filter((l) => l.scope === scope) : data.lessons;
    return base.slice(0, previewCount);
  }, [data, scope, previewCount]);

  const total = useMemo(() => {
    if (!data?.lessons) return 0;
    return scope ? data.lessons.filter((l) => l.scope === scope).length : data.lessons.length;
  }, [data, scope]);

  if (isLoading) {
    return (
      <div
        className={`flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1.5 ${className}`}
        aria-hidden
      >
        <BookOpen className="size-3.5 text-[var(--color-content-tertiary)]" />
        <span className="h-3 w-8 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>
    );
  }

  return (
    <details
      className={`group relative ${className}`}
      onToggle={(e) => {
        // When the details element closes, close the sidebar too.
        if (!(e.currentTarget as HTMLDetailsElement).open && isOpen) {
          closeLesson();
        }
      }}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1.5 text-sm text-[var(--color-content-secondary)] transition-all duration-150 hover:border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        aria-label={`${total} memories — click to expand`}
      >
        <BookOpen className="size-3.5 shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="font-medium tabular-nums">{total}</span>
        <span className="hidden text-xs text-[var(--color-content-tertiary)] sm:inline">
          {total === 1 ? 'memory' : 'memories'}
        </span>
        <ChevronRight
          className="size-3.5 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200 group-open:rotate-90"
          aria-hidden
        />
      </summary>

      {/* Dropdown lesson list */}
      <AnimatePresence>
        <motion.div
          key="dropdown"
          initial={{ opacity: 0, y: -4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.97 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="absolute right-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-lg"
        >
          {lessons.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[var(--color-content-tertiary)]">
              No memories yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border-subtle)]">
              {lessons.map((lesson) => {
                const isSelected =
                  openLesson?.key === lesson.key && openLesson?.scope === lesson.scope;
                return (
                  <li key={`${lesson.scope}::${lesson.key}`}>
                    <button
                      onClick={() =>
                        isSelected
                          ? closeLesson()
                          : openLessonById({ scope: lesson.scope, key: lesson.key })
                      }
                      className={[
                        'flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors duration-100',
                        isSelected
                          ? 'bg-[var(--color-accent-subtle)]'
                          : 'hover:bg-[var(--color-bg-elevated)]',
                      ].join(' ')}
                      aria-pressed={isSelected}
                    >
                      <code
                        className={[
                          'truncate font-mono text-xs font-medium',
                          isSelected
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-content-primary)]',
                        ].join(' ')}
                      >
                        {lesson.key}
                      </code>
                      <span className="line-clamp-1 text-xs text-[var(--color-content-tertiary)]">
                        {lesson.value.slice(0, 80)}
                        {lesson.value.length > 80 ? '…' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
              {total > previewCount && (
                <li>
                  <p className="px-4 py-2 text-xs text-[var(--color-content-tertiary)]">
                    +{total - previewCount} more · visit{' '}
                    <a
                      href="/lore"
                      className="text-[var(--color-accent)] underline-offset-2 hover:underline"
                    >
                      Lore Explorer
                    </a>{' '}
                    to see all.
                  </p>
                </li>
              )}
            </ul>
          )}
        </motion.div>
      </AnimatePresence>
    </details>
  );
}
