'use server';

/**
 * Server actions for memory (lore) management.
 * Update, archive, restore, purge, and paginated list — all user-scoped.
 *
 * Every one of these goes through LoreKit's own REST API (the `memories` edge
 * function) rather than querying PostgREST directly. They used to do the
 * latter: a second, hand-written copy of predicates the REST handlers already
 * own — the tenant scope, the active-vs-archived partition, the expiry filter,
 * the keyset cursor, the label containment quoting. Two implementations of one
 * contract drift, and these had. The dashboard is now a client of the same
 * documented surface the CLI and every agent use.
 *
 * They stay SERVER actions (rather than moving into the client hooks) so the
 * Explorer's data path is unchanged from the components' point of view, and so
 * the access token is read from the cookie session rather than handed to the
 * browser bundle.
 */

import { revalidatePath } from 'next/cache';
import type { Page } from '@/lib/pagination/keyset';
import { clampPageSize } from '@/lib/pagination/keyset';
import { dateRangeBounds, type DateRangeInput } from '@/lib/pagination/filters';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { normalizeTags } from '@/lib/tag-filter';
import { filtersToBody, normalizeFilters, type Filter } from '@/lib/filters';
import { lessonFromMemoryEntry } from '@/lib/lesson-entry';
import { serverAccessToken } from '@/lib/api/session-server';
import { RestApiError } from '@/lib/api/rest';
import {
  archiveMemoryRequest,
  listMemoriesRequest,
  listMemoriesPostRequest,
  purgeMemoriesRequest,
  restoreMemoryRequest,
  updateMemoryRequest,
} from '@/lib/api/memories';

/** Turn any thrown value into the `{ error }` string these actions return. */
function messageFor(err: unknown): string {
  if (err instanceof RestApiError) return err.message;
  return err instanceof Error ? err.message : 'Request failed';
}

// ── Edit / update ─────────────────────────────────────────────────────────────

export interface UpdateLessonInput {
  /** The fields to change. Only `value`, `tags`, and TTL are user-editable in the UI. */
  value: string;
  tags: string[];
  /** When set, refreshes the expiry to now() + ttl_days. */
  ttl_days?: number | null;
  /** When true, removes any existing expiry (makes the memory permanent). */
  clear_ttl?: boolean;
}

/**
 * Update an existing active memory's value, labels and TTL.
 *
 * Two calls, because the memory is addressed by its natural key here and
 * `PATCH /memories/:id` is addressed by row id: resolve the row, then patch it.
 * A PATCH is deliberately preferred over the `POST /memories` upsert — it
 * touches only the named columns, so `source_agent` / `trigger` / `created_at`
 * are preserved by construction instead of being read back and forwarded by
 * hand (which is what the previous direct-RPC version had to do, and what would
 * silently blank them the day someone forgot a field).
 *
 * Returns `{ id }` on success, or `{ error }` on failure.
 */
export async function updateLesson(
  scope: string,
  key: string,
  input: UpdateLessonInput,
): Promise<{ id: string | null; error?: string }> {
  const token = await serverAccessToken();
  if (!token) return { id: null, error: 'Not authenticated' };

  try {
    const found = await listMemoriesRequest(token, { scope, key, limit: 1 });
    const target = found.entries[0];
    if (!target) return { id: null, error: 'Memory not found' };

    const updated = await updateMemoryRequest(token, target.id, {
      value: input.value,
      tags: input.tags,
      ...(input.ttl_days != null ? { ttl_days: input.ttl_days } : {}),
      ...(input.clear_ttl ? { clear_ttl: true } : {}),
    });

    revalidatePath('/lore');
    return { id: updated.id };
  } catch (err) {
    return { id: null, error: messageFor(err) };
  }
}

/**
 * The result of a lifecycle mutation.
 *
 * `ok` rather than the row id these actions used to return: the REST archive is
 * a 204 and the restore a `{ restored: true }`, neither of which carries an id,
 * and no caller ever read one — the optimistic cache updates key on
 * `(scope, key)`, which is what the user acted on. Resolving an id purely to
 * satisfy the old signature would cost a round trip nobody spends.
 */
export interface LessonMutationResult {
  ok: boolean;
  error?: string;
}

/** Soft-archive a memory (never a hard delete — no `force`). */
export async function archiveLesson(scope: string, key: string): Promise<LessonMutationResult> {
  const token = await serverAccessToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    await archiveMemoryRequest(token, scope, key);
    revalidatePath('/lore');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: messageFor(err) };
  }
}

/** Restore an archived memory back to active. */
export async function restoreLesson(scope: string, key: string): Promise<LessonMutationResult> {
  const token = await serverAccessToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const { restored } = await restoreMemoryRequest(token, scope, key);
    revalidatePath('/lore');
    return { ok: restored };
  } catch (err) {
    return { ok: false, error: messageFor(err) };
  }
}

/**
 * Hard-delete archived memories older than retentionDays for the current user.
 * Returns the count of permanently deleted rows.
 */
export async function purgeArchivedLessons(
  retentionDays = 30,
): Promise<{ purged: number; error?: string }> {
  const token = await serverAccessToken();
  if (!token) return { purged: 0, error: 'Not authenticated' };

  try {
    const { purged } = await purgeMemoriesRequest(token, retentionDays);
    revalidatePath('/lore');
    return { purged };
  } catch (err) {
    return { purged: 0, error: messageFor(err) };
  }
}

// ---------------------------------------------------------------------------
// Paginated memory listing
// ---------------------------------------------------------------------------

export interface MemoryFilters {
  /** Filter to a single scope. Omit or pass null to return all scopes. */
  scope?: string | null;
  /** Case-insensitive substring match against `key` or `value`. */
  search?: string;
  /** Inclusive `from` / exclusive-day-end `to` interval on `created_at`. */
  range?: DateRangeInput | null;
  /**
   * Labels (`memories.tags`) a row must carry — ALL of them, not any.
   * Absent or empty means "no label filter".
   *
   * @deprecated Superseded by {@link MemoryFilters.filters}. Folded into it
   * below (as a `label` filter with the `all` operator) so there is one
   * translation to the wire.
   */
  tags?: string[];
  /**
   * The Explorer's filter bar: one condition per dimension (label / agent /
   * trigger / repo / branch / pull request), OR within a dimension and AND
   * across them. Translated by the pure `filtersToBody`, which is the
   * single place the UI vocabulary meets the wire vocabulary.
   */
  filters?: Filter[];
  /** Page size, default 50, hard max 100. */
  pageSize?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /**
   * When true, returns only archived memories (archived_at IS NOT NULL).
   * When false/absent, returns only active memories (archived_at IS NULL).
   */
  showArchived?: boolean;
  /**
   * Narrow to memories whose TTL runs out within N days — the route's
   * `expiring_within_days` (1–365). Absent means no expiry narrowing.
   *
   * Passed straight through and bounded by the route, not here: an
   * out-of-range value is a 400 the caller should see, and re-implementing the
   * bound in the dashboard would be a second copy of it to keep in step.
   */
  expiringWithinDays?: number;
}

export type MemoryPage = Page<LessonEntry>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EMPTY_PAGE: MemoryPage = { rows: [], nextCursor: null, hasMore: false };

/**
 * List a keyset page of the memories the caller can see, newest first, with
 * optional combinable filters (scope / substring / date interval / labels).
 *
 * Ordering is `created_at desc` — `sort: 'created_at'` — not the route's
 * `updated_at` default: a memory migrated with a backdated `created_at` belongs
 * at its original position in the Explorer, which is the order the list has
 * always been in.
 *
 * Sent over `POST /memories/list` rather than `GET /memories`: the filter bar's
 * dimensions are unbounded, and the query transport caps each one at 2048
 * characters — the ceiling that made the Explorer stop loading past ~50-75
 * selected values in a dimension. The BODY carries the filters; the ordering,
 * the page size and the cursor are unchanged.
 *
 * Fails closed to an empty page on auth failure or API error — read-only, so
 * failing closed is safe.
 */
export async function listMemories(filters: MemoryFilters = {}): Promise<MemoryPage> {
  const token = await serverAccessToken();
  if (!token) return EMPTY_PAGE;

  const pageSize = clampPageSize(filters.pageSize, { def: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE });
  const bounds = dateRangeBounds(filters.range);

  // The deprecated `tags` shorthand becomes a `label` filter with the `all`
  // operator — exactly what it has always meant — unless the caller already
  // supplied one, in which case the explicit bar wins.
  const legacyTags = normalizeTags(filters.tags);
  const explicit = normalizeFilters(filters.filters ?? []);
  const bar =
    legacyTags.length === 0 || explicit.some((f) => f.field === 'label')
      ? explicit
      : normalizeFilters([...explicit, { field: 'label', operator: 'all', values: legacyTags }]);

  try {
    const page = await listMemoriesPostRequest(token, {
      limit: pageSize,
      sort: 'created_at',
      archived: filters.showArchived ?? false,
      ...(filters.expiringWithinDays !== undefined
        ? { expiring_within_days: filters.expiringWithinDays }
        : {}),
      ...(filters.scope ? { scope: filters.scope } : {}),
      ...(filters.search ? { q: filters.search } : {}),
      ...(bounds.gte ? { created_since: bounds.gte } : {}),
      ...(bounds.lt ? { created_until: bounds.lt } : {}),
      // OR within a dimension, AND across dimensions — see `filtersToBody`.
      ...filtersToBody(bar),
      ...(filters.cursor ? { cursor: filters.cursor } : {}),
    });

    return {
      rows: page.entries.map(lessonFromMemoryEntry),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  } catch (err) {
    console.error('[listMemories] REST error:', messageFor(err));
    return EMPTY_PAGE;
  }
}
