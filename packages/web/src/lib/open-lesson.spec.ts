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
import {
  activeMemoryId,
  lessonResolvedLocally,
  resolveLessonParam,
  resolveOpenLesson,
} from './open-lesson';

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

describe('lessonResolvedLocally', () => {
  // The gate on `useLessonByRef`. True suppresses the by-scope+key fetch, so
  // every case here is really "does an in-app click stay off the network".

  it('is false with no lesson ref — there is nothing to resolve, so nothing to fetch', () => {
    expect(
      lessonResolvedLocally({ lessonRef: null, cacheLessons: [A, B], prefetched: A }),
    ).toBe(false);
  });

  it('is true from the active cache alone — the command palette / header-dropdown click', () => {
    // `NavigationCommands` and `MemoryExpandButton` call `openLessonById(ref)`
    // with NO prefetch; they render from the same `useLoreData()` query, so the
    // cache arm is the only thing keeping those two clicks off the network.
    expect(
      lessonResolvedLocally({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [A, B],
        prefetched: null,
      }),
    ).toBe(true);
  });

  it('is true from a prefetch alone — the Lore Explorer click, which passes the lesson', () => {
    expect(
      lessonResolvedLocally({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: A,
      }),
    ).toBe(true);
  });

  it('is false when neither source holds it — the cold deep-link visit that must fetch', () => {
    expect(
      lessonResolvedLocally({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [B],
        prefetched: null,
      }),
    ).toBe(false);
  });

  it('ignores a prefetch for a different ref, so a stale one cannot suppress the fetch', () => {
    expect(
      lessonResolvedLocally({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: [],
        prefetched: B,
      }),
    ).toBe(false);
  });

  it('is false while the cache is still loading', () => {
    expect(
      lessonResolvedLocally({
        lessonRef: { scope: 'global', key: 'a' },
        cacheLessons: undefined,
        prefetched: null,
      }),
    ).toBe(false);
  });

  it('agrees with resolveOpenLesson: whenever it says true, the resolver resolves without the fetch', () => {
    // The property that makes the gate safe — a "resolved locally" verdict the
    // resolver disagreed with would suppress the fetch and then show nothing.
    const ref = { scope: 'global', key: 'a' };
    for (const local of [
      { cacheLessons: [A, B], prefetched: null },
      { cacheLessons: [], prefetched: A },
      { cacheLessons: [A], prefetched: A },
    ]) {
      expect(lessonResolvedLocally({ lessonRef: ref, ...local })).toBe(true);
      expect(
        resolveOpenLesson({
          lessonRef: ref,
          ...local,
          lessonByRef: null,
          memoryId: null,
          memoryByIdLesson: null,
        }),
      ).toBe(A);
    }
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

describe('resolveLessonParam', () => {
  const UUID = 'dce19167-34ed-4f91-b304-552062680b50';

  // The documented form, unchanged by the UUID tolerance.
  it('resolves a JSON-encoded { scope, key } as a ref', () => {
    expect(resolveLessonParam({ scope: 'global', key: 'a' }, '{"scope":"global","key":"a"}')).toEqual(
      { ref: { scope: 'global', key: 'a' }, memoryId: null },
    );
  });

  // The regression this function exists for. A bare UUID in `?lesson=` is not
  // valid JSON, so `deserialise` fell back to null and the link was a SILENT
  // no-op: nothing opened, nothing warned. It now behaves like `?memoryId=`.
  it('recovers a RAW uuid — the shape that used to be a silent no-op', () => {
    // `deserialise` yields the fallback (null) because JSON.parse threw, so the
    // raw string is the only place the id is still visible.
    expect(resolveLessonParam(null, UUID)).toEqual({ ref: null, memoryId: UUID });
  });

  // Every other Explorer param IS JSON-encoded, so a tool applying that rule
  // uniformly to a UUID emits ?lesson=%22<uuid>%22. Accepting only the raw form
  // would fix hand-written links and leave generated ones broken.
  it('recovers a JSON-QUOTED uuid, which parses to a plain string', () => {
    expect(resolveLessonParam(UUID, `"${UUID}"`)).toEqual({ ref: null, memoryId: UUID });
  });

  it('accepts an uppercase uuid', () => {
    const upper = UUID.toUpperCase();
    expect(resolveLessonParam(null, upper).memoryId).toBe(upper);
  });

  it('is inert for an absent param', () => {
    expect(resolveLessonParam(null, null)).toEqual({ ref: null, memoryId: null });
  });

  // Garbage must resolve to NEITHER field. A non-UUID id would 400 at
  // `GET /memories/:id`, and a half-formed ref would fire a by-ref fetch that
  // cannot match anything — inert is the only honest answer.
  it('is inert for a value that is neither a usable ref nor a uuid', () => {
    for (const [value, raw] of [
      ['not-a-uuid', 'not-a-uuid'],
      [null, 'garbage'],
      [42, '42'],
      [[], '[]'],
      [{ scope: 'global' }, '{"scope":"global"}'],
      [{ key: 'a' }, '{"key":"a"}'],
      [{ scope: 'global', key: 42 }, '{"scope":"global","key":42}'],
      [{ scope: '', key: 'a' }, '{"scope":"","key":"a"}'],
      [{ scope: 'global', key: '' }, '{"scope":"global","key":""}'],
      // A uuid-like string that is the wrong length must not slip through.
      [null, 'dce19167-34ed-4f91-b304-552062680b5'],
      [null, `${UUID}-extra`],
    ] as [unknown, string | null][]) {
      expect(resolveLessonParam(value, raw), `value=${JSON.stringify(value)}`).toEqual({
        ref: null,
        memoryId: null,
      });
    }
  });

  // A real ref wins outright: the id arms are a FALLBACK for a param that could
  // not be read as a ref, never a second interpretation of one that could.
  it('prefers a usable ref over any uuid reading of the same param', () => {
    expect(resolveLessonParam({ scope: 'global', key: UUID }, '{"scope":"global","key":"…"}')).toEqual(
      { ref: { scope: 'global', key: UUID }, memoryId: null },
    );
  });

  // Feeding the recovered id through the SAME activeMemoryId the explicit param
  // uses is what makes dismissal (and therefore closing the sheet) work for the
  // alias without reimplementing it.
  it('produces an id that dismisses like an explicit ?memoryId=', () => {
    const { memoryId } = resolveLessonParam(null, UUID);
    expect(activeMemoryId(memoryId, null)).toBe(UUID);
    expect(activeMemoryId(memoryId, UUID)).toBeNull();
  });
});
