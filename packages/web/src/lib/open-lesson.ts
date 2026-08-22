import type { LessonEntry } from '@/components/lore/LessonCard';

export interface LessonRef {
  scope: string;
  key: string;
}

/** Canonical UUID form — what `GET /memories/:id` accepts (and 400s without). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a memory id the by-id endpoint will accept? */
function isMemoryId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A `{ scope, key }` ref, or null for anything that is not one. */
function asLessonRef(value: unknown): LessonRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { scope, key } = value as Partial<LessonRef>;
  if (typeof scope !== 'string' || typeof key !== 'string') return null;
  if (scope === '' || key === '') return null;
  return { scope, key };
}

export interface LessonParamResolution {
  /** The scope+key ref, when the param holds one. */
  ref: LessonRef | null;
  /** A memory id recovered from the param, when it holds one of those instead. */
  memoryId: string | null;
}

/**
 * Interpret the `?lesson=` param, which people and tools populate in three
 * different shapes.
 *
 * The param's documented form is a JSON-encoded `{ scope, key }`. But a bare
 * memory UUID in it used to be a **silent no-op**: `useUrlState`'s `deserialise`
 * runs `JSON.parse`, a bare UUID is not valid JSON, so it fell back to `null` —
 * `lessonRef` was null, `isOpen` was false, and the link landed on `/lore` with
 * nothing open and nothing logged. Nothing whatsoever told the person their link
 * was malformed.
 *
 * That is a trap worth absorbing rather than documenting harder. `?memoryId=` is
 * the param for a raw UUID, but `?lesson=` is the name everything ELSE points at
 * — the `link` command emits it, `docs/cli.md` names it — so someone holding an
 * `id` and reading about `lesson` writes the combination that cannot work. Both
 * forms now resolve to the same state.
 *
 * Three accepted shapes, all mapped here so the provider has one thing to read:
 *
 * | Param value | Result |
 * |---|---|
 * | `{"scope":"…","key":"…"}` (JSON) | `ref` — the documented form, unchanged |
 * | `<uuid>` (raw) | `memoryId` — behaves exactly like `?memoryId=<uuid>` |
 * | `"<uuid>"` (JSON string) | `memoryId` — same |
 *
 * The JSON-string case is not hypothetical padding: every OTHER Explorer param
 * IS JSON-encoded, so a tool that applies that rule uniformly to a UUID produces
 * `?lesson=%22<uuid>%22`. Accepting only the raw form would fix the trap for
 * hand-written links and leave it open for exactly the generated ones.
 *
 * A value that is neither a usable ref nor a UUID resolves to NEITHER field —
 * garbage stays inert rather than becoming a doomed by-id request (the endpoint
 * 400s on a non-UUID) or a by-ref fetch for a half-formed ref. That last case is
 * why `asLessonRef` validates instead of trusting the type: `deserialise` casts
 * `JSON.parse` output blindly, so the declared `LessonRef` generic is a claim
 * about the URL, not a guarantee about the value.
 *
 * Takes BOTH the deserialised value and the raw string because the two shapes
 * are distinguishable only before and only after parsing respectively: a raw
 * UUID never survives `JSON.parse`, and a JSON-quoted one is only a UUID once
 * parsed.
 *
 * Pure, so all three shapes are unit-tested rather than asserted in a comment.
 */
export function resolveLessonParam(value: unknown, raw: string | null): LessonParamResolution {
  const ref = asLessonRef(value);
  if (ref) return { ref, memoryId: null };
  // A JSON-quoted UUID parses to a string; a bare one fails to parse at all and
  // is only visible in `raw`.
  if (isMemoryId(value)) return { ref: null, memoryId: value };
  if (isMemoryId(raw)) return { ref: null, memoryId: raw };
  return { ref: null, memoryId: null };
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

/**
 * Does this entry answer that ref? The ONE scope+key comparison in this module.
 *
 * Every resolution arm below and `lessonResolvedLocally` ask the same question,
 * and `lessonResolvedLocally` only means anything if it asks it the same way the
 * resolver does — a predicate that decided "already resolvable" on a rule the
 * resolver disagreed with would suppress the fetch AND then show nothing.
 */
function matchesRef(entry: LessonEntry | null | undefined, ref: LessonRef): entry is LessonEntry {
  return entry !== null && entry !== undefined && entry.scope === ref.scope && entry.key === ref.key;
}

/**
 * Is the open `lessonRef` already answerable without going to the network?
 *
 * The gate on `useLessonByRef`: true means some local source already holds the
 * memory, so the by-scope+key fetch stays disabled and only a cold deep-link
 * visit — a `?lesson=` URL opened in a fresh tab — reaches the network.
 *
 * Two independent local sources, NOT one. A click-prefetch is the obvious one,
 * but only `LoreExplorer` passes a second argument to `openLessonById`; the
 * command palette and the header memory dropdown pass the ref alone. What keeps
 * THOSE off the network is the active-memories cache — they render their own
 * lists from the same `useLoreData()` query the provider reads, so the clicked
 * memory is in `cacheLessons` by construction. Drop the cache arm and every
 * in-app click from those two surfaces issues a redundant fetch.
 *
 * Pure, so the guarantee is unit-testable rather than asserted in a comment.
 */
export function lessonResolvedLocally(args: {
  lessonRef: LessonRef | null;
  cacheLessons: LessonEntry[] | undefined;
  prefetched: LessonEntry | null;
}): boolean {
  const { lessonRef, cacheLessons, prefetched } = args;
  if (!lessonRef) return false;
  return (
    (cacheLessons?.some((l) => matchesRef(l, lessonRef)) ?? false) ||
    matchesRef(prefetched, lessonRef)
  );
}

export function resolveOpenLesson(args: {
  lessonRef: LessonRef | null;
  cacheLessons: LessonEntry[] | undefined;
  prefetched: LessonEntry | null;
  lessonByRef: LessonEntry | null | undefined;
  memoryId: string | null;
  memoryByIdLesson: LessonEntry | null | undefined;
}): LessonEntry | null {
  const { lessonRef, cacheLessons, prefetched, lessonByRef, memoryId, memoryByIdLesson } = args;

  if (lessonRef) {
    // 1. The active-memories cache (covers all non-archived lessons).
    const found = cacheLessons?.find((l) => matchesRef(l, lessonRef));
    if (found) return found;
    // 2. A caller-supplied prefetch (e.g. an archived memory not in the cache).
    if (matchesRef(prefetched, lessonRef)) {
      return prefetched;
    }
    // 3. Fetched by scope+key directly, so a `?lesson=` deep link resolves even
    //    when the memory is outside the recent/active cache window — the
    //    "opens blank" case for a shared link to any older memory.
    if (matchesRef(lessonByRef, lessonRef)) {
      return lessonByRef;
    }
    // Set but still unresolved: show nothing — never fall through to `memoryId`.
    return null;
  }

  // No `lesson` — the `memoryId` deep link, fetched by id directly.
  if (memoryId && memoryByIdLesson) return memoryByIdLesson;
  return null;
}
