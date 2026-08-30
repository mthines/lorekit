'use client';

/**
 * MemorySidebarProvider
 *
 * Makes the memory detail sidebar available on every dashboard page, not just
 * the Lore Explorer. The open lesson is stored in URL search params so the
 * sidebar survives page refreshes and is shareable via URL.
 *
 * URL params used:
 *   lesson    – JSON-encoded { scope, key } identifying the open lesson.
 *               Absent (not in URL) when no lesson is selected.
 *               ALSO accepts a memory UUID, raw or JSON-quoted, in which case it
 *               behaves exactly like `memoryId` below. It previously ignored one
 *               silently — see `resolveLessonParam` for why that is worth
 *               absorbing rather than documenting harder.
 *   memoryId  – Plain DB row id (NOT JSON-encoded). A robust deep-link form that
 *               fetches the memory by id, so the sheet opens even when the row is
 *               outside the Explorer's recent/active window. Absent when unused.
 *               It is a deep-link ENTRY point, not the open/closed flag: closing
 *               the sheet records the dismissal locally and leaves the param in
 *               the URL (see `activeMemoryId`), because stripping it would be a
 *               second navigation racing the Explorer's own scope/filter write.
 *               Wins over a UUID in `lesson` when both are present.
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
import { useSearchParams } from 'next/navigation';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { LessonDetailSheet } from '@/components/lore/LessonDetailSheet';
import { useLoreData, useMemoryById, useLessonByRef } from '@/lib/queries/lore';
import {
  activeMemoryId,
  lessonResolvedLocally,
  resolveLessonParam,
  resolveOpenLesson,
  type LessonRef,
} from '@/lib/open-lesson';
import type { LessonEntry } from '@/components/lore/LessonCard';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MemorySidebarContextValue {
  /** The fully-resolved open lesson, or null while loading or when closed. */
  openLesson: LessonEntry | null;
  /** The raw lesson reference (scope + key) even while data is loading. */
  openLessonRef: LessonRef | null;
  /**
   * Open the sidebar for a specific lesson. Reacts immediately (optimistic).
   *
   * Pass the full `lesson` object when the caller already has it (e.g. from
   * the archived list) so the sidebar can render without a separate lookup.
   * Active-list callers omit it; the provider resolves it from `useLoreData`.
   *
   * Omitting it is only free for a caller that renders its OWN list from
   * `useLoreData` — `NavigationCommands` and `MemoryExpandButton` both do, so
   * the memory is in the provider's `cacheLessons` by construction and
   * `lessonResolvedLocally` keeps the click off the network. A caller that
   * sources the ref from anywhere else (a URL, a search result, a webhook
   * payload) and omits the prefetch triggers a `useLessonByRef` fetch — which
   * is correct, and is the deep-link path, but it is a network round-trip.
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
  // without waiting for the router navigation round-trip — which is why the READ
  // still goes through it rather than through `searchParams` below: reading the
  // ref raw would lose the optimistic layer and make the sheet lag a navigation
  // on every in-app click.
  //
  // The declared generic is a claim about what the URL SHOULD hold, not a
  // guarantee — `deserialise` casts `JSON.parse` output blindly — so the value is
  // classified at runtime by the pure `resolveLessonParam`, which also recovers
  // the two UUID shapes this param used to swallow silently.
  const [lessonParamValue, setLessonRef] = useUrlState<LessonRef | null>('lesson', null);

  // Holds a pre-fetched lesson passed by the caller (e.g. an archived memory
  // that won't be present in the active useLoreData cache). Kept in a ref so
  // it doesn't cause an extra render cycle; mirrored to state so the memoised
  // openLesson value updates when it changes.
  const prefetchedRef = useRef<LessonEntry | null>(null);
  const [prefetched, setPrefetched] = useState<LessonEntry | null>(null);

  // Resolve the ref to a full LessonEntry using the shared TanStack Query cache.
  // The same query is used by the Lore Explorer — zero extra network requests.
  const { data } = useLoreData();

  // The robust deep-link form: a plain `?memoryId=<id>` (NOT JSON-encoded, so it
  // never has to invert the dashboard's useUrlState encoding). Read directly from
  // the search params rather than through useUrlState, then fetched by id — this
  // resolves the memory even when it is outside the Explorer's recent/active
  // window, the case where the `?lesson=` scope+key form opens blank.
  const searchParams = useSearchParams();

  // Split `?lesson=` into the ref it usually holds and the memory id it is also
  // now allowed to hold — see `resolveLessonParam` for the three shapes and why
  // a bare UUID there used to do nothing at all.
  //
  // MEMOISED because the resolution builds a fresh `{ scope, key }`: `lessonRef`
  // is a dependency of the `openLesson` memo and of `contextValue`, so returning
  // a new object identity every render would re-run both on every render and
  // push a new context value to every consumer of the sidebar. Both inputs are
  // themselves stable per navigation (`lessonParamValue` is memoised inside
  // `useUrlState`), so this recomputes exactly when the URL changes.
  const lessonParamRaw = searchParams.get('lesson');
  const { ref: lessonRef, memoryId: lessonParamMemoryId } = useMemo(
    () => resolveLessonParam(lessonParamValue, lessonParamRaw),
    [lessonParamValue, lessonParamRaw],
  );

  // `?memoryId=` stays the explicit, documented spelling and WINS when both are
  // present — a caller who named the param meant it. `?lesson=<uuid>` is the
  // forgiving alias, so the two converge on one id from here on and every
  // downstream behaviour (the by-id fetch, dismissal, `isOpen`) is shared rather
  // than reimplemented for the alias.
  const urlMemoryId = searchParams.get('memoryId') ?? lessonParamMemoryId;
  // Closing the sheet dismisses the id locally rather than rewriting the URL —
  // the pure `activeMemoryId` docblock has the why (a second router.replace in
  // the same tick clobbers the Explorer's scope/filter write).
  const [dismissedMemoryId, setDismissedMemoryId] = useState<string | null>(null);
  const memoryId = activeMemoryId(urlMemoryId, dismissedMemoryId);
  const { data: memoryByIdLesson } = useMemoryById(memoryId);

  // A shared `?lesson={scope,key}` link opens blank when the memory is outside
  // the Explorer's recent/active window — the sheet only resolved the ref
  // against the loaded page set. Fetch it by scope+key as a fallback, but only
  // when it isn't already resolvable locally, so only a cold deep-link visit
  // reaches the network. The predicate is the pure, unit-tested
  // `lessonResolvedLocally` — see its docblock for why the active-memories
  // cache, not the click-prefetch, is what covers the palette and the header
  // dropdown (both call `openLessonById` with the ref alone).
  const resolvedLocally = lessonResolvedLocally({
    lessonRef,
    cacheLessons: data?.lessons,
    prefetched,
  });
  const { data: lessonByRef } = useLessonByRef(resolvedLocally ? null : lessonRef);

  // Resolution precedence lives in the pure `resolveOpenLesson` (unit-tested):
  // `lesson` strictly wins, so a cache-missing `lesson` shows nothing rather
  // than falling through to whatever `memoryId` is still in the URL.
  const openLesson = useMemo<LessonEntry | null>(
    () =>
      resolveOpenLesson({
        lessonRef,
        cacheLessons: data?.lessons,
        prefetched,
        lessonByRef,
        memoryId,
        memoryByIdLesson,
      }),
    [lessonRef, data, prefetched, lessonByRef, memoryId, memoryByIdLesson],
  );

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
    // Dismiss the `memoryId` deep link in local state — no navigation, so this
    // can never race the scope/filter write LoreExplorer makes in the same tick.
    // A null id is a no-op; the pure `resolveOpenLesson` still gives `lesson`
    // strict precedence, so a lingering param never shows the wrong memory.
    setDismissedMemoryId(urlMemoryId);
  }, [lessonRef, setLessonRef, urlMemoryId]);

  const contextValue = useMemo<MemorySidebarContextValue>(
    () => ({
      openLesson,
      openLessonRef: lessonRef,
      openLessonById,
      closeLesson,
      // isOpen derives from the ref (or the memoryId param), not the resolved
      // lesson, so it is truthy immediately after openLessonById() or on a
      // `?memoryId=` visit — even before the lore data / by-id fetch loads.
      isOpen: lessonRef !== null || memoryId !== null,
    }),
    [openLesson, lessonRef, openLessonById, closeLesson, memoryId],
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
