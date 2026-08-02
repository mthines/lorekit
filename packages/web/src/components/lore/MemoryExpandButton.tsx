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
import { BookOpen, ChevronDown, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useLoreData } from '@/lib/queries/lore';
import { useMemoryTotal } from '@/lib/queries/plan';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { MemoryCard, memoryFromLesson } from '@/components/memory/MemoryCard';
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
  const { data: memoryTotal = 0 } = useMemoryTotal();
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
    if (!isDropdownOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsDropdownOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isDropdownOpen]);

  const lessons = useMemo<LessonEntry[]>(() => {
    if (!data?.lessons) return [];
    const base = scope ? data.lessons.filter((l) => l.scope === scope) : data.lessons;
    return base.slice(0, previewCount);
  }, [data, scope, previewCount]);

  // The badge count must NOT come from `data.lessons` — that is only the first
  // page of the list (capped at the API's 100-row maximum), so counting it stuck
  // the badge at "100 memories" for any larger account. The unscoped total is the
  // SAME figure the /settings/plan page shows (`useMemoryTotal` → the shared
  // `lorekit_memory_count` RPC), so the two never disagree. A `scope`-filtered
  // instance falls back to the exact per-scope aggregate from GET /memories/scopes.
  const total = useMemo(() => {
    if (scope) return data?.scopes.find((s) => s.scope === scope)?.count ?? 0;
    return memoryTotal;
  }, [data, scope, memoryTotal]);

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
                      <MemoryCard
                        memory={memoryFromLesson(lesson)}
                        density="compact"
                        selected={isSelected}
                        onClick={() => {
                          if (isSelected) {
                            closeLesson();
                          } else {
                            openLessonById({ scope: lesson.scope, key: lesson.key });
                          }
                          setIsDropdownOpen(false);
                        }}
                      />
                    </li>
                  );
                })}
                {total > previewCount && (
                  <li>
                    {/* Full-width tap target — the whole row navigates to the
                        Lore Explorer, not just an inline text link. min-h-11
                        keeps it a comfortable touch target on mobile. */}
                    <a
                      href="/lore"
                      onClick={() => setIsDropdownOpen(false)}
                      className="flex min-h-11 w-full items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-[var(--color-accent)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                    >
                      See all {total} memories
                      <ArrowRight className="size-3.5 shrink-0" aria-hidden />
                    </a>
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
