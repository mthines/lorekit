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

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
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
  /**
   * Open the sidebar for a specific lesson. Reacts immediately (optimistic).
   * Pass the full `lesson` object when the caller already has it (e.g. from
   * the archived list) so the sidebar can render without a separate lookup.
   * Active-list callers omit it; the provider resolves it from useLoreData.
   */
  openLessonById: (ref: LessonRef, lesson?: LessonEntry) => void;
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

  // Holds a pre-fetched lesson passed by the caller (e.g. an archived memory
  // that won't be present in the active useLoreData cache). Kept in a ref so
  // it doesn't cause an extra render cycle; mirrored to state so the memoised
  // openLesson value updates when it changes.
  const prefetchedRef = useRef<LessonEntry | null>(null);
  const [prefetched, setPrefetched] = useState<LessonEntry | null>(null);

  // Resolve the ref to a full LessonEntry using the shared TanStack Query cache.
  // The same query is used by the Lore Explorer — zero extra network requests.
  const { data } = useLoreData();

  const openLesson = useMemo<LessonEntry | null>(() => {
    if (!lessonRef) return null;
    // 1. Try the active-memories cache (covers all non-archived lessons).
    if (data?.lessons) {
      const found = data.lessons.find(
        (l) => l.scope === lessonRef.scope && l.key === lessonRef.key,
      );
      if (found) return found;
    }
    // 2. Fall back to the caller-supplied prefetched lesson (e.g. archived).
    if (
      prefetched &&
      prefetched.scope === lessonRef.scope &&
      prefetched.key === lessonRef.key
    ) {
      return prefetched;
    }
    return null;
  }, [lessonRef, data, prefetched]);

  const openLessonById = useCallback(
    (ref: LessonRef, lesson?: LessonEntry) => {
      const next = lesson ?? null;
      prefetchedRef.current = next;
      setPrefetched(next);
      setLessonRef(ref);
    },
    [setLessonRef],
  );

  // Only write the URL when a lesson is actually open. Calling this
  // unconditionally (e.g. from LoreExplorer's scope-select handler, which
  // closes any open lesson while also setting ?scope) would fire a second
  // router.replace built from the *pre-scope* search params, clobbering the
  // scope param that was set in the same tick. Guarding on lessonRef makes the
  // close a no-op navigation when nothing is open.
  const closeLesson = useCallback(() => {
    if (lessonRef !== null) {
      prefetchedRef.current = null;
      setPrefetched(null);
      setLessonRef(null);
    }
  }, [lessonRef, setLessonRef]);

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
