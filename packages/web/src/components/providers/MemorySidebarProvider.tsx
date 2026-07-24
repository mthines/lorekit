'use client';

/**
 * MemorySidebarProvider
 *
 * Makes the memory detail sidebar available on every dashboard page, not just
 * the Lore Explorer. The open lesson is stored in URL search params so the
 * sidebar survives page refreshes and is shareable via URL.
 *
 * URL params used:
 *   lesson   – JSON-encoded object { scope, key } identifying the open lesson
 *              (absent when no lesson is selected).
 *
 * Param lifecycle:
 *   - Persists across navigation within the dashboard (hard refresh reopens it).
 *   - Automatically cleaned when no lesson is selected (value equals default).
 *
 * Consuming components call `useMemorySidebar()` to read and drive the sidebar.
 */

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { LessonDetailSheet } from '@/components/lore/LessonDetailSheet';
import { useLoreData } from '@/lib/queries/lore';
import type { LessonEntry } from '@/components/lore/LessonCard';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LessonRef {
  scope: string;
  key: string;
}

interface MemorySidebarContextValue {
  /** The currently open lesson, or null. */
  openLesson: LessonEntry | null;
  /** Open the sidebar for a specific lesson. */
  openLessonById: (ref: LessonRef) => void;
  /** Close the sidebar. */
  closeLesson: () => void;
  /** Whether the sidebar is currently open. */
  isOpen: boolean;
}

// ── Context ───────────────────────────────────────────────────────────────────

const MemorySidebarContext = createContext<MemorySidebarContextValue | null>(null);

export function useMemorySidebar(): MemorySidebarContextValue {
  const ctx = useContext(MemorySidebarContext);
  if (!ctx) {
    throw new Error('useMemorySidebar must be used within <MemorySidebarProvider>');
  }
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

const DEFAULT_LESSON_REF: LessonRef | null = null;
const LESSON_URL_KEY = 'lesson';

interface MemorySidebarProviderProps {
  children: React.ReactNode;
}

export function MemorySidebarProvider({ children }: MemorySidebarProviderProps) {
  // Stored in URL as JSON: null when no lesson is selected, { scope, key } when open.
  const [lessonRef, setLessonRef] = useUrlState<LessonRef | null>(
    LESSON_URL_KEY,
    DEFAULT_LESSON_REF,
  );

  // Resolve the lesson ref to a full LessonEntry using the cached query data.
  // The lore query is shared with the Lore Explorer – no extra network request.
  const { data } = useLoreData();

  const openLesson = useMemo<LessonEntry | null>(() => {
    if (!lessonRef || !data?.lessons) return null;
    return (
      data.lessons.find(
        (l) => l.scope === lessonRef.scope && l.key === lessonRef.key,
      ) ?? null
    );
  }, [lessonRef, data]);

  const openLessonById = useCallback(
    (ref: LessonRef) => setLessonRef(ref),
    [setLessonRef],
  );

  const closeLesson = useCallback(() => setLessonRef(null), [setLessonRef]);

  const contextValue = useMemo<MemorySidebarContextValue>(
    () => ({
      openLesson,
      openLessonById,
      closeLesson,
      isOpen: openLesson !== null,
    }),
    [openLesson, openLessonById, closeLesson],
  );

  return (
    <MemorySidebarContext.Provider value={contextValue}>
      {children}
      {/* The sheet renders at the top of the tree so it overlays any page */}
      <LessonDetailSheet
        lesson={openLesson}
        onClose={closeLesson}
        onMutated={closeLesson}
      />
    </MemorySidebarContext.Provider>
  );
}
