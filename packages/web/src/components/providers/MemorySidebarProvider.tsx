'use client';

/**
 * MemorySidebarProvider
 *
 * Makes the memory detail sidebar available on every dashboard page, not just
 * the Lore Explorer. The open lesson is stored in URL search params so the
 * sidebar survives page refreshes and is shareable via URL.
 *
 * URL params used:
 *   lesson  – JSON-encoded { scope, key } identifying the open lesson.
 *             Absent (not in URL) when no lesson is selected.
 *
 * ## SSR & hydration
 * `useUrlState` reads from `useSearchParams()`, which is empty on the server.
 * This component must be inside a <Suspense> boundary (handled in layout.tsx)
 * so Next.js can shell-render on the server and fill the real value on the
 * client without a hydration mismatch.
 *
 * ## Optimistic open state
 * `useUrlState` already provides an optimistic local value so the UI reacts
 * immediately to setState calls. Additionally, `isOpen` is derived from the
 * lessonRef (the URL-or-optimistic value) rather than from `openLesson` (the
 * resolved LessonEntry), so the sidebar renders as "open" immediately even
 * while the lore data query is loading in the background. The `LessonDetailSheet`
 * gracefully handles `lesson={null}` by rendering nothing, so there is no
 * visible gap.
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
  /** The fully-resolved open lesson, or null while loading or when closed. */
  openLesson: LessonEntry | null;
  /** The raw lesson reference (scope + key) even while data is loading. */
  openLessonRef: LessonRef | null;
  /** Open the sidebar for a specific lesson. Reacts immediately (optimistic). */
  openLessonById: (ref: LessonRef) => void;
  /** Close the sidebar. Reacts immediately (optimistic). */
  closeLesson: () => void;
  /**
   * True whenever a lesson ref is held — even while the lore query is still
   * resolving. Use this for opening animations and aria-expanded rather than
   * `openLesson !== null`, which would lag behind by one data-load cycle.
   */
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

interface MemorySidebarProviderProps {
  children: React.ReactNode;
}

export function MemorySidebarProvider({ children }: MemorySidebarProviderProps) {
  // Stored in URL as JSON: null when closed, { scope, key } when open.
  // useUrlState provides optimistic local state so open/close is immediate
  // without waiting for the router navigation round-trip.
  const [lessonRef, setLessonRef] = useUrlState<LessonRef | null>('lesson', null);

  // Resolve the ref to a full LessonEntry using the shared TanStack Query cache.
  // The same query is used by the Lore Explorer — zero extra network requests.
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
      openLessonRef: lessonRef,
      openLessonById,
      closeLesson,
      // isOpen derives from the ref, not the resolved lesson, so it is truthy
      // immediately after openLessonById() — even before the lore data loads.
      isOpen: lessonRef !== null,
    }),
    [openLesson, lessonRef, openLessonById, closeLesson],
  );

  return (
    <MemorySidebarContext.Provider value={contextValue}>
      {children}
      {/* Sheet renders at the top of the tree so it overlays every page. */}
      <LessonDetailSheet
        lesson={openLesson}
        onClose={closeLesson}
        onMutated={closeLesson}
      />
    </MemorySidebarContext.Provider>
  );
}
