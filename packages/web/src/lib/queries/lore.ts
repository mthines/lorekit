'use client';

import { useQuery, useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { scopeType } from '@/lib/scope';
import { dayCountsFromActivity } from '@/lib/aggregations';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { listMemories, archiveLesson, restoreLesson, type MemoryFilters, type MemoryPage } from '@/lib/lore';
import type { DateRange } from '@/components/ui/DateRangePicker';
import { normalizeTags, type TagCount } from '@/lib/tag-filter';
import { lessonFromMemoryEntry } from '@/lib/lesson-entry';
import { browserAccessToken } from '@/lib/api/session-browser';
import { activityRequest, listMemoriesRequest, listScopesRequest, listTagsRequest } from '@/lib/api/memories';

export interface LoreData {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
  /** Per-UTC-day counts for the contribution heatmap. */
  heatmapData: { date: string; count: number }[];
}

/** Page size for the legacy one-shot fetch — the API's per-request maximum. */
const LEGACY_PAGE_SIZE = 100;

/**
 * Every read below goes through LoreKit's REST API rather than PostgREST.
 *
 * The scope tree, the label catalog and the (legacy) whole-dataset fetch were
 * the last three `select … then reduce in the browser` queries in the
 * dashboard, and all three carried the bug `GET /memories/scopes` was created
 * to fix: PostgREST caps the rows it returns, so past that cap a scope or a
 * label silently disappears from its own filter and every count is understated
 * — no error, no truncation signal. The aggregates are computed in Postgres now
 * (`lorekit_memory_scopes` / `lorekit_memory_tags`), which is exact at any size
 * and ships one row per group instead of one per memory.
 *
 * The token is the browser session's own access token; the API re-verifies it
 * and RLS applies exactly as it did to the direct queries. With no session the
 * read REJECTS with {@link NotAuthenticatedError} instead of resolving empty —
 * see that class for why, and `isNotAuthenticated` for how a consumer tells it
 * apart from a real failure.
 */

/**
 * No session (signed out, or the refresh failed mid-session) — the read below
 * could not be attempted at all.
 *
 * These hooks FAIL rather than resolving to an empty result, deliberately: an
 * empty Explorer and a signed-out Explorer look identical, and a user whose
 * session lapsed while the tab was open would be told they have no lore. The
 * cost of that choice is that every consumer must be able to tell this error
 * apart from a real failure, which is what {@link isNotAuthenticated} is for —
 * exported alongside the class because `instanceof` across a bundle boundary is
 * a trap the check should not leave to each call site.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

/** True when a query rejected because there was no session to read with. */
export function isNotAuthenticated(error: unknown): boolean {
  return error instanceof NotAuthenticatedError;
}

/**
 * TanStack retries a failed query three times by default. Being signed out is
 * not transient — retrying it costs three round trips and three renders to
 * reach the same answer — so it is the one error that fails immediately.
 * Everything else (a dropped connection, a 5xx) keeps the default budget.
 */
export function retryUnlessSignedOut(failureCount: number, error: unknown): boolean {
  return !isNotAuthenticated(error) && failureCount < 3;
}

async function requireBrowserToken(): Promise<string> {
  const token = await browserAccessToken();
  if (!token) throw new NotAuthenticatedError();
  return token;
}

// ---------------------------------------------------------------------------
// Scope-tree-only fetch (used by the Lore Explorer sidebar).
// One row per scope from `GET /memories/scopes`, already counted and sorted by
// the database — this stays its own lightweight query so the tree renders
// immediately while the paginated lesson list streams in separately.
// ---------------------------------------------------------------------------

async function fetchScopes(signal?: AbortSignal): Promise<ScopeNode[]> {
  const token = await requireBrowserToken();
  const { scopes } = await listScopesRequest(token, signal);

  return scopes.map(({ scope, count }) => {
    const parts = scope.split('::');
    return {
      scope,
      type: scopeType(scope),
      label: parts[parts.length - 1] ?? scope,
      count,
    };
  });
}

// ---------------------------------------------------------------------------
// Label (tag) catalog — powers the Explorer's label filter bar.
//
// Deliberately a SEPARATE query from the lesson list: the list is server-side
// filtered, so deriving the catalog from the loaded pages would make the
// available labels shrink as soon as one is picked — you could narrow but never
// widen or switch. The catalog is filter-independent, exactly like the scope
// tree.
//
// It IS however archived-aware: the bar renders in both the active and the
// archived view, and the list partitions on `archived_at`, so a catalog pinned
// to active rows would describe the wrong population in archived mode — wrong
// counts, and archive-only labels missing from their own filter. `?archived=`
// selects the partition on the server, where the counting happens.
// ---------------------------------------------------------------------------

async function fetchTagCatalog(showArchived: boolean, signal?: AbortSignal): Promise<TagCount[]> {
  const token = await requireBrowserToken();
  const { tags } = await listTagsRequest(token, showArchived, signal);
  return tags;
}

export function useTagCatalog(showArchived = false) {
  return useQuery<TagCount[]>({
    // Keyed on the partition it describes — flipping "Archived" swaps the
    // catalog instead of reusing the other view's counts.
    queryKey: ['lore-tags', showArchived],
    queryFn: ({ signal }) => fetchTagCatalog(showArchived, signal),
    // Matches the scope tree: read-heavy, changes only when an agent writes.
    staleTime: 90_000,
    retry: retryUnlessSignedOut,
  });
}

export function useScopeTree() {
  return useQuery<ScopeNode[]>({
    queryKey: ['lore-scopes'],
    queryFn: ({ signal }) => fetchScopes(signal),
    // Scope tree is read-heavy — keep data for 90 s before refetching.
    staleTime: 90_000,
    retry: retryUnlessSignedOut,
  });
}

// ---------------------------------------------------------------------------
// Legacy: scopes + a first page of lessons + a heatmap series in one hook.
// Kept for back-compat with any remaining call sites; prefer `useScopeTree` +
// `useMemories` for new code.
//
// The heatmap series no longer comes from the returned lessons: a heatmap
// derived from the first page describes the first page, not the account, and
// the previous 500-row fetch it was derived from was itself capped. It comes
// from `GET /memories/activity`, which buckets per UTC day in Postgres.
// ---------------------------------------------------------------------------

async function fetchLoreData(signal?: AbortSignal): Promise<LoreData> {
  const token = await requireBrowserToken();

  const [scopesRes, page, activity] = await Promise.all([
    listScopesRequest(token, signal),
    listMemoriesRequest(token, { limit: LEGACY_PAGE_SIZE, sort: 'created_at' }, signal),
    activityRequest(token, { bucket: 'day' }, signal),
  ]);

  const scopes: ScopeNode[] = scopesRes.scopes.map(({ scope, count }) => {
    const parts = scope.split('::');
    return {
      scope,
      type: scopeType(scope),
      label: parts[parts.length - 1] ?? scope,
      count,
    };
  });

  return {
    scopes,
    lessons: page.entries.map(lessonFromMemoryEntry),
    heatmapData: dayCountsFromActivity(activity.buckets),
  };
}

export function useLoreData() {
  return useQuery<LoreData>({
    queryKey: ['lore'],
    queryFn: ({ signal }) => fetchLoreData(signal),
    // Lore explorer is read-heavy — keep data for 90 s before refetching.
    staleTime: 90_000,
    retry: retryUnlessSignedOut,
  });
}

// ---------------------------------------------------------------------------
// Paginated lesson list — mirrors `useAuditLog` exactly.
// ---------------------------------------------------------------------------

export interface UseMemoriesFilters {
  /** Scope to filter to, or null for all scopes. */
  scope: string | null;
  /** Substring search applied to key and value. */
  search: string;
  /** Date range filter on created_at. */
  range: DateRange | null;
  /** Labels a memory must ALL carry. Empty means no label filter. */
  tags?: string[];
  /** When true, fetches archived memories instead of active ones. */
  showArchived?: boolean;
}

/**
 * `useInfiniteQuery` over the `listMemories` server action.
 *
 * Changing any filter key resets pagination automatically because the query
 * key changes — no manual "reset cursor on filter change" bookkeeping needed.
 * `fetchNextPage` drives the "Load more" control in `LoreExplorer`.
 */
export function useMemories(filters: UseMemoriesFilters) {
  return useInfiniteQuery<MemoryPage>({
    // `tags` is APPENDED, never inserted: the archive mutations select archived
    // vs active pages by `queryKey[4]`, so the first five segments are a fixed
    // contract. Extend this key at the end only.
    queryKey: [
      'memories',
      filters.scope,
      filters.search,
      filters.range,
      filters.showArchived ?? false,
      normalizeTags(filters.tags),
    ],
    queryFn: ({ pageParam }) => {
      const args: MemoryFilters = {
        scope: filters.scope ?? undefined,
        search: filters.search || undefined,
        range: filters.range,
        tags: normalizeTags(filters.tags),
        cursor: pageParam as string | null,
        showArchived: filters.showArchived,
      };
      return listMemories(args);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    // Lore explorer is read-heavy — 90 s matches the scope-tree stale time.
    staleTime: 90_000,
  });
}

// ---------------------------------------------------------------------------
// Optimistic archive / restore mutations
// ---------------------------------------------------------------------------

/**
 * Removes a lesson from all active `['memories', ...]` infinite-query pages
 * in the cache. Called optimistically before the archive server action fires.
 */
function removeFromActiveCache(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: string,
  key: string,
) {
  queryClient.setQueriesData<InfiniteData<MemoryPage>>(
    { queryKey: ['memories'], exact: false },
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          rows: page.rows.filter((r) => !(r.scope === scope && r.key === key)),
        })),
      };
    },
  );
}

/**
 * Removes a lesson from all archived `['memories', ..., true]` pages.
 * Called optimistically before the restore server action fires.
 */
function removeFromArchivedCache(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: string,
  key: string,
) {
  queryClient.setQueriesData<InfiniteData<MemoryPage>>(
    // Match only queries that have showArchived=true (last key segment = true).
    { predicate: (q) => q.queryKey[0] === 'memories' && q.queryKey[4] === true },
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          rows: page.rows.filter((r) => !(r.scope === scope && r.key === key)),
        })),
      };
    },
  );
}

interface ArchiveRestoreArgs { scope: string; key: string }

/**
 * `useMutation` for archiving a memory.
 *
 * Optimistic update: immediately removes the lesson from all active memory
 * list caches. On error the snapshot is restored (rollback). On success the
 * scope-tree and lore-data queries are invalidated so counts stay accurate.
 */
export function useArchiveLesson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, key }: ArchiveRestoreArgs) => archiveLesson(scope, key),
    onMutate: async ({ scope, key }) => {
      // Cancel any in-flight refetches so they don't overwrite our optimistic update.
      await queryClient.cancelQueries({ queryKey: ['memories'] });
      // Snapshot the current cache for rollback.
      const snapshot = queryClient.getQueriesData<InfiniteData<MemoryPage>>({ queryKey: ['memories'] });
      // Optimistically remove from the active list.
      removeFromActiveCache(queryClient, scope, key);
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      // Rollback: restore all snapshotted query data.
      if (context?.snapshot) {
        for (const [queryKey, data] of context.snapshot) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSettled: () => {
      // Whether success or failure, sync the scope tree, the label catalog,
      // and the legacy lore cache.
      void queryClient.invalidateQueries({ queryKey: ['lore-scopes'] });
      void queryClient.invalidateQueries({ queryKey: ['lore-tags'] });
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
      void queryClient.invalidateQueries({ queryKey: ['memory-total'] });
      // Invalidate archived list so it picks up the newly archived row.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'memories' && q.queryKey[4] === true,
      });
    },
  });
}

/**
 * `useMutation` for restoring an archived memory.
 *
 * Optimistic update: immediately removes the lesson from all archived memory
 * list caches. On error the snapshot is restored. On success the scope-tree,
 * lore-data, and active memory list caches are invalidated.
 */
export function useRestoreLesson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, key }: ArchiveRestoreArgs) => restoreLesson(scope, key),
    onMutate: async ({ scope, key }) => {
      await queryClient.cancelQueries({ queryKey: ['memories'] });
      const snapshot = queryClient.getQueriesData<InfiniteData<MemoryPage>>({ queryKey: ['memories'] });
      // Optimistically remove from the archived list.
      removeFromArchivedCache(queryClient, scope, key);
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        for (const [queryKey, data] of context.snapshot) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['lore-scopes'] });
      void queryClient.invalidateQueries({ queryKey: ['lore-tags'] });
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
      void queryClient.invalidateQueries({ queryKey: ['memory-total'] });
      // Invalidate active list so the restored memory reappears.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'memories' && q.queryKey[4] === false,
      });
    },
  });
}
