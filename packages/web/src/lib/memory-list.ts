/**
 * The Explorer's memory-list request: the filter state the UI holds, translated
 * into the `POST /memories/list` body, and the response translated back into a
 * page of `LessonEntry` rows.
 *
 * Pure on purpose, and in its own module rather than in `lib/lore.ts`: the list
 * used to be the `listMemories` SERVER ACTION, and Next's app router runs server
 * actions one at a time per client. On `/lore` it queued behind the two other
 * server actions the top bar fired on every load and every window focus (plan
 * usage, pending invites), so the list arrived last and the header's activity
 * bar stayed on long after every visible panel had loaded. The list is now a
 * plain browser request (`fetchMemoryPage` in `queries/lore.ts`) that runs in
 * parallel and honours React Query's AbortSignal; this module is the part of
 * the old action that was never about transport, so it moved here unchanged and
 * gained a spec.
 */

import type { ListMemoriesBody, MemoryPageResponse } from '@lorekit/schemas/memory';
import type { LessonEntry } from '@/components/lore/LessonCard';
import type { Page } from '@/lib/pagination/keyset';
import { clampPageSize } from '@/lib/pagination/keyset';
import { dateRangeBounds, type DateRangeInput } from '@/lib/pagination/filters';
import { normalizeTags } from '@/lib/tag-filter';
import { filtersToBody, normalizeFilters, type Filter } from '@/lib/filters';
import { DEFAULT_EXPLORER_SORT, type ExplorerSort } from '@/lib/explorer-sort';
import {
  retentionConditionsToListBody,
  type RetentionConditions,
} from '@/lib/retention-filter';
import { lessonFromMemoryEntry } from '@/lib/lesson-entry';

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
  /**
   * The retention-preview trio (`lib/retention-filter.ts`) — the same three
   * conditions a saved retention policy matches on, narrowing the list to
   * what that policy would catch. Absent/empty means no narrowing.
   */
  retentionConditions?: RetentionConditions;
  /**
   * The list order (`lib/explorer-sort.ts`) — `created_at` (Newest, the
   * default), `opened_count` (Most chosen, migration 00113) or `last_opened_at`
   * (Recent read, migration 00115). A cursor is only
   * valid for the order that minted it; the route restarts at page one if the
   * two disagree, and the Explorer's query key changes with the sort anyway.
   */
  sort?: ExplorerSort;
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

/**
 * `total` — exact count of every memory the request's filters matched,
 * ignoring pagination (`MemoryPageResponseSchema`'s optional field,
 * `lorekit_memory_list`'s `total_count` column, migration 00094). `Page<T>`
 * itself stays total-less: it is shared with `useAuditLog`, which has no
 * equivalent aggregate, so this is `MemoryPage`'s own addition rather than a
 * field every keyset page now carries.
 */
export type MemoryPage = Page<LessonEntry> & { total?: number };

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * The `POST /memories/list` body for one keyset page of the memories the caller
 * can see.
 *
 * Ordering defaults to `created_at desc` — `sort: 'created_at'` — not the
 * route's `updated_at` default: a memory migrated with a backdated `created_at`
 * belongs at its original position in the Explorer, which is the order the list
 * has always been in. `filters.sort` swaps in `opened_count` ("Most chosen") or
 * `last_opened_at` ("Recent read").
 *
 * A body rather than a query string: the filter bar's dimensions are unbounded,
 * and the query transport caps each one at 2048 characters — the ceiling that
 * made the Explorer stop loading past ~50-75 selected values in a dimension.
 */
export function memoryListBody(filters: MemoryFilters = {}): Partial<ListMemoriesBody> {
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

  return {
    limit: pageSize,
    sort: filters.sort ?? DEFAULT_EXPLORER_SORT,
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
    ...retentionConditionsToListBody(filters.retentionConditions ?? {}),
    ...(filters.cursor ? { cursor: filters.cursor } : {}),
  };
}

/** A `POST /memories/list` response as the page shape the Explorer renders. */
export function memoryPageFromResponse(page: MemoryPageResponse): MemoryPage {
  return {
    rows: page.entries.map(lessonFromMemoryEntry),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: page.total,
  };
}
