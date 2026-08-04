import type { LessonEntry } from '@/components/lore/LessonCard';

export interface LessonRef {
  scope: string;
  key: string;
}

/**
 * Resolve which memory the detail sheet shows from the two independent
 * deep-link params the sidebar reads: the `lesson` scope+key ref and the plain
 * `memoryId`.
 *
 * `lesson` **strictly wins**: when a `lessonRef` is set the sheet shows that
 * memory or nothing — it never falls through to `memoryId`. Without that rule,
 * a `?lesson=` that misses the active-cache (and carries no prefetch) would fall
 * through and silently display whatever `?memoryId=` happened to still be in the
 * URL — the wrong memory. `memoryId` resolves only when no `lesson` is set,
 * which is the deep-link case it exists for.
 *
 * Pure and dependency-free (type-only import), so it is unit-testable in the
 * node vitest project — the reason the resolution lives here rather than inline
 * in the client provider.
 */
/**
 * The `memoryId` that is still open: the URL's param, unless the user has
 * dismissed that exact id.
 *
 * Closing the sheet deliberately does NOT strip `?memoryId=` from the URL. That
 * strip needed its own `router.replace`, built from the pre-mutation search
 * params, and the Lore Explorer calls `closeLesson()` in the same tick as its
 * own scope / filter writes — so the second navigation landed last and clobbered
 * the scope or filter the user had just set. Dismissal is local state instead,
 * keyed BY id so a later deep link to a different memory still opens the sheet.
 * The cost is that the param survives in the URL, which only means a refresh
 * re-opens the deep link it names.
 */
export function activeMemoryId(
  memoryId: string | null,
  dismissedMemoryId: string | null,
): string | null {
  if (memoryId === null || memoryId === dismissedMemoryId) return null;
  return memoryId;
}

export function resolveOpenLesson(args: {
  lessonRef: LessonRef | null;
  cacheLessons: LessonEntry[] | undefined;
  prefetched: LessonEntry | null;
  memoryId: string | null;
  memoryByIdLesson: LessonEntry | null | undefined;
}): LessonEntry | null {
  const { lessonRef, cacheLessons, prefetched, memoryId, memoryByIdLesson } = args;

  if (lessonRef) {
    // 1. The active-memories cache (covers all non-archived lessons).
    const found = cacheLessons?.find(
      (l) => l.scope === lessonRef.scope && l.key === lessonRef.key,
    );
    if (found) return found;
    // 2. A caller-supplied prefetch (e.g. an archived memory not in the cache).
    if (
      prefetched &&
      prefetched.scope === lessonRef.scope &&
      prefetched.key === lessonRef.key
    ) {
      return prefetched;
    }
    // Set but unresolved: show nothing — never fall through to `memoryId`.
    return null;
  }

  // No `lesson` — the `memoryId` deep link, fetched by id directly.
  if (memoryId && memoryByIdLesson) return memoryByIdLesson;
  return null;
}
