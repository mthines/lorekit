'use client';

/**
 * MemoryExpandButton
 *
 * A compact widget that displays the count of loaded memories and opens the
 * memory detail sidebar when clicked on a specific lesson. Delegates full
 * lesson browsing to the Lore Explorer page.
 *
 * Uses a controlled open state (not a native <details> element) so that
 * framer-motion exit animations play correctly and click-outside closing works.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useLoreData } from '@/lib/queries/lore';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import type { LessonEntry } from '@/components/lore/LessonCard';

interface MemoryExpandButtonProps {
  /**
   * Scope filter for the preview list. When provided, only lessons from this
   * scope appear in the dropdown. Omit to show across all scopes.
   */
  scope?: string;
  /** Max lessons to preview in the dropdown. @default 5 */
  previewCount?: number;
  className?: string;
}

export function MemoryExpandButton({
  scope,
  previewCount = 5,
  className = '',
}: MemoryExpandButtonProps) {
  const { data, isLoading } = useLoreData();
  const { openLesson, openLessonById, closeLesson } = useMemorySidebar();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the dropdown when clicking outside.
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setIsDropdownOpen(false);
    }
  }, []);

  useEffect(() => {
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDropdownOpen, handleClickOutside]);

  // Close on Escape.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsDropdownOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

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
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsDropdownOpen((v) => !v)}
        aria-expanded={isDropdownOpen}
        aria-haspopup="listbox"
        aria-label={`${total} ${total === 1 ? 'memory' : 'memories'} — click to expand`}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1.5 text-sm text-[var(--color-content-secondary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <BookOpen className="size-3.5 shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="font-medium tabular-nums">{total}</span>
        <span className="hidden text-xs text-[var(--color-content-tertiary)] sm:inline">
          {total === 1 ? 'memory' : 'memories'}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {isDropdownOpen && (
          <motion.div
            key="dropdown"
            role="listbox"
            aria-label="Recent memories"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
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
                    <li key={`${lesson.scope}::${lesson.key}`} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            closeLesson();
                          } else {
                            openLessonById({ scope: lesson.scope, key: lesson.key });
                          }
                          setIsDropdownOpen(false);
                        }}
                        className={[
                          'flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors duration-100',
                          isSelected
                            ? 'bg-[var(--color-accent-subtle)]'
                            : 'hover:bg-[var(--color-bg-elevated)]',
                        ].join(' ')}
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
        )}
      </AnimatePresence>
    </div>
  );
}
