/**
 * The detail-sheet resolution precedence between the two deep-link params
 * (`lesson` scope+key and the plain `memoryId`).
 *
 * The load-bearing rule is that `lesson` STRICTLY wins: a `?lesson=` that misses
 * the active cache must show nothing, never fall through to whatever `?memoryId=`
 * is still in the URL — otherwise a stale `memoryId` silently displays the wrong
 * memory. The `memoryId` deep-link path is exercised here too, so the headline
 * behaviour is covered.
 */

import { describe, it, expect } from 'vitest';
import type { MemoryEntry } from '@lorekit/schemas/memory';
import { lessonFromMemoryEntry } from './lesson-entry';
import { resolveOpenLesson } from './open-lesson';

function lesson(scope: string, key: string) {
  const entry: MemoryEntry = {
    id: `id-${scope}-${key}`,
    scope,
    key,
    value: 'v',
    tags: [],
    source_agent: null,
    trigger: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    expires_at: null,
    archived_at: null,
  };
  return lessonFromMemoryEntry(entry);
}

const A = lesson('global', 'a');
const B = lesson('global', 'b');

describe('resolveOpenLesson', () => {
  it('resolves the lesson ref from the active cache', () => {
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [A, B],
        prefetched: null,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBe(A);
  });

  it('falls back to a caller-supplied prefetch when the lesson is not in the cache', () => {
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: A,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBe(A);
  });

  it('resolves a memoryId memory when no lesson ref is set — the deep-link path', () => {
    expect(
      resolveOpenLesson({
        lessonRef: null,
        cacheLessons: [],
        prefetched: null,
        memoryId: 'id-global-a',
        memoryByIdLesson: A,
      }),
    ).toBe(A);
  });

  it('gives the lesson ref strict precedence — a cache-missing lesson shows nothing, never the memoryId memory', () => {
    // Regression: without strict precedence a lesson that misses the cache fell
    // through and returned B (the memoryId memory).
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: null,
        memoryId: 'id-global-b',
        memoryByIdLesson: B,
      }),
    ).toBeNull();
  });

  it('ignores memoryId while a lesson ref resolves', () => {
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [A],
        prefetched: null,
        memoryId: 'id-global-b',
        memoryByIdLesson: B,
      }),
    ).toBe(A);
  });

  it('returns null when nothing is open', () => {
    expect(
      resolveOpenLesson({
        lessonRef: null,
        cacheLessons: [],
        prefetched: null,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBeNull();
  });

  it('returns null while the memoryId fetch is still loading', () => {
    expect(
      resolveOpenLesson({
        lessonRef: null,
        cacheLessons: [],
        prefetched: null,
        memoryId: 'id-global-a',
        memoryByIdLesson: undefined,
      }),
    ).toBeNull();
  });
});
