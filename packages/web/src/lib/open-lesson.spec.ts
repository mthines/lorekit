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
import { activeMemoryId, resolveOpenLesson } from './open-lesson';

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
        lessonByRef: null,
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
        lessonByRef: null,
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
        lessonByRef: null,
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
        lessonByRef: null,
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
        lessonByRef: null,
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
        lessonByRef: null,
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
        lessonByRef: null,
        memoryId: 'id-global-a',
        memoryByIdLesson: undefined,
      }),
    ).toBeNull();
  });

  it('resolves a lesson by its fetched scope+key when it is outside the cache — the "opens blank" fix', () => {
    // A shared `?lesson=` link to a memory not in the recent window: the
    // by-scope+key fetch resolves it instead of the sheet opening blank.
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: null,
        lessonByRef: A,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBe(A);
  });

  it('prefers the cache over the by-ref fetch when both resolve the lesson', () => {
    const cached = lesson('global', 'a');
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [cached],
        prefetched: null,
        lessonByRef: A,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBe(cached);
  });

  it('ignores a by-ref result for a different ref', () => {
    // The fetch is keyed by scope+key; a stale result for another ref must not
    // resolve the current one.
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: null,
        lessonByRef: B,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBeNull();
  });

  it('returns null while the by-ref fetch is still loading', () => {
    expect(
      resolveOpenLesson({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: null,
        lessonByRef: undefined,
        memoryId: null,
        memoryByIdLesson: null,
      }),
    ).toBeNull();
  });
});

describe('activeMemoryId', () => {
  it('is the URL param while nothing has been dismissed', () => {
    expect(activeMemoryId('id-a', null)).toBe('id-a');
  });

  it('goes null once that exact id is dismissed — how the sheet closes without a navigation', () => {
    expect(activeMemoryId('id-a', 'id-a')).toBeNull();
  });

  it('re-opens for a different id, so a later deep link still works after a close', () => {
    expect(activeMemoryId('id-b', 'id-a')).toBe('id-b');
  });

  it('is null when the URL carries no memoryId at all', () => {
    expect(activeMemoryId(null, null)).toBeNull();
    expect(activeMemoryId(null, 'id-a')).toBeNull();
  });
});
