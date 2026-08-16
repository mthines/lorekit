'use client';

import {
  keepPreviousData,
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { scopeType } from '@/lib/scope';
import { dayCountsFromActivity } from '@/lib/aggregations';
import { heatmapSince } from '@/lib/heatmap-window';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { listMemories, archiveLesson, restoreLesson, type MemoryFilters, type MemoryPage } from '@/lib/lore';
import type { AbsoluteRange } from '@/lib/time-range';
import { normalizeTags } from '@/lib/tag-filter';
import { lessonFromMemoryEntry } from '@/lib/lesson-entry';
import { browserAccessToken } from '@/lib/api/session-browser';
import {
  activityRequest,
  getMemoryByIdRequest,
  getMemoryByRefRequest,
  listFacetsRequest,
  listMemoriesRequest,
  listScopesRequest,
} from '@/lib/api/memories';
import { RestApiError } from '@/lib/api/rest';
import {
  filtersToFacetParams,
  normalizeFilters,
  type FacetValue,
  type Filter,
} from '@/lib/filters';
import type { ListFacetsQuery } from '@lorekit/schemas/memory';

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

/**
 * True when the API answered that the REQUEST cannot succeed, whoever asks and
 * however often: the id is not a UUID (`400`, `GET /memories/:id` validates it)
 * or it names no memory this account can see (`404` — an archived, purged or
 * foreign row). Both are documented outcomes of a hand-built `?memoryId=` deep
 * link, not transport failures.
 */
export function isUnretryableRequest(error: unknown): boolean {
  return error instanceof RestApiError && (error.status === 400 || error.status === 404);
}

/**
 * {@link useMemoryById}'s retry policy: {@link retryUnlessSignedOut} plus the two
 * answers a by-id read gets when the id itself is the problem. The signed-out
 * rule alone retries everything else, so a deep link to an archived or bad id
 * spent four requests and four renders reaching the same 404.
 */
export function retryMemoryById(failureCount: number, error: unknown): boolean {
  return !isUnretryableRequest(error) && retryUnlessSignedOut(failureCount, error);
}

async function requireBrowserToken(): Promise<string> {
  const token = await browserAccessToken();
  if (!token) throw new NotAuthenticatedError();
  return token;
}

// ---------------------------------------------------------------------------
// Scope-tree-only fetch (used by the Lore Explorer sidebar).
// One row per scope from `GET /memories/scopes`, already counted and sorted by
// the database (count desc, scope asc — 00065), which is the order the chip
// strip renders since this maps but never re-sorts. Stays its own lightweight
// query so the tree renders immediately while the paginated lesson list streams
// in separately.
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
// Facet catalog — every filterable value, per dimension, for the filter menu.
//
// A SEPARATE query from the lesson list, NOT derived from the loaded pages —
// the reason the single-dimension label catalog it replaced was one too, and it
// only gets stronger with six dimensions: derived from the loaded pages, the
// menu's options would shrink to whatever the current filter happened to return,
// so you could narrow but never widen or switch — and cross-dimension type-ahead
// ("type `main`, get Branch → main") would only ever surface values already
// visible in the list, which is precisely the case where you did not need the
// menu.
//
// But the catalog IS filter-aware: it passes the active filters to the endpoint
// (`GET /memories/facets`, drill-down since migration 00057), so once you pick
// `agent=claude` the counts shown for repo, branch, … narrow to "how many
// claude memories also carry this value". The endpoint self-excludes each
// dimension from its own filter, so a filtered dimension still lists its
// alternatives to switch between — the one thing deriving from the loaded pages
// could never do. Keyed on the filter bar so the counts refresh as it changes.
//
// Archived-aware for the same reason: active and archived are different
// populations, so a catalog pinned to one shows the wrong counts and hides the
// other's values from their own filter.
// ---------------------------------------------------------------------------

async function fetchFacets(
  params: Partial<ListFacetsQuery>,
  signal?: AbortSignal,
): Promise<FacetValue[]> {
  const token = await requireBrowserToken();
  const { facets } = await listFacetsRequest(token, params, signal);
  return facets;
}

export function useFacetCatalog(
  showArchived = false,
  filters: readonly Filter[] = [],
  scope: string | null = null,
) {
  // Normalise so the query key is stable across the equivalent-but-differently-
  // shaped filter arrays a render can produce, exactly as `useMemories` does.
  const bar = normalizeFilters(filters as Filter[]);
  const facetParams = filtersToFacetParams(bar);
  return useQuery<FacetValue[]>({
    queryKey: ['lore-facets', showArchived, scope, bar],
    queryFn: ({ signal }) =>
      fetchFacets(
        {
          archived: showArchived ? 'true' : 'false',
          // Scope the catalog to the selected scope, matching the list
          // (`useMemories` sends the same `scope`). Without it the counts would
          // reflect every scope while the list shows one, overstating the yield;
          // a null scope omits the param, so the all-scopes view is unchanged.
          ...(scope ? { scope } : {}),
          ...facetParams,
        },
        signal,
      ),
    // Toggling a filter changes the key, which would otherwise blank `data` to
    // `undefined` while the drilled-down counts load — so every other value in
    // the group the user is standing in flickers out and back. Keep the previous
    // catalog on screen until the new one arrives: the counts update in place
    // rather than disappearing. (`isPlaceholderData` is available if a caller
    // ever wants to dim them mid-refetch; the flicker fix needs only this.)
    placeholderData: keepPreviousData,
    // Matches the scope tree and the label catalog: read-heavy, changes only
    // when an agent writes.
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
    // `since` is EXPLICIT, not left to the endpoint's default. That default is
    // 200 days, sized when the heatmap was a fixed 26 weeks; the desktop grid
    // is a year now, so a bare call would return nothing for its oldest ~164
    // days and the chart would draw them as empty — reading as "no memories",
    // not as "not fetched". `heatmapSince` derives the bound from the same
    // constant the grid renders, so the two cannot drift apart again.
    activityRequest(token, { bucket: 'day', since: heatmapSince(new Date().toISOString()) }, signal),
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
// Single memory by DB row id.
//
// Resolves a `/lore?memoryId=…` deep link directly, so the detail sheet opens
// regardless of whether the row is in the Explorer's recent/active window — the
// limitation the `?lesson=` scope+key form has, since it only resolves against
// the loaded page set. Disabled (no fetch) when `id` is null.
// ---------------------------------------------------------------------------

export function useMemoryById(id: string | null) {
  return useQuery<LessonEntry | null>({
    queryKey: ['memory-by-id', id],
    enabled: id !== null,
    queryFn: async ({ signal }) => {
      if (!id) return null;
      const token = await requireBrowserToken();
      const entry = await getMemoryByIdRequest(token, id, signal);
      return lessonFromMemoryEntry(entry);
    },
    staleTime: 90_000,
    retry: retryMemoryById,
  });
}

// ---------------------------------------------------------------------------
// Single memory by its natural key (scope + key).
//
// Resolves a `/lore?lesson={scope,key}` deep link directly via
// `getMemoryByRefRequest` (a precise one-row read — see its doc), so the detail
// sheet opens even when the memory is outside the Explorer's recent/active
// window — the "opens blank" case for a shared `?lesson=` link to any older
// memory. Disabled (no fetch) when `ref` is null.
// ---------------------------------------------------------------------------

export function useLessonByRef(ref: { scope: string; key: string } | null) {
  return useQuery<LessonEntry | null>({
    queryKey: ['lesson-by-ref', ref?.scope, ref?.key],
    enabled: ref !== null,
    queryFn: async ({ signal }) => {
      if (!ref) return null;
      const token = await requireBrowserToken();
      const entry = await getMemoryByRefRequest(token, ref.scope, ref.key, signal);
      return entry ? lessonFromMemoryEntry(entry) : null;
    },
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
  /**
   * Resolved window filter on `created_at`, half-open `[from, to)`, or `null`
   * for unbounded.
   *
   * `AbsoluteRange` (`lib/time-range.ts`), NOT the calendar picker's
   * `DateRange`. The two are structurally identical — both are `{from, to}`
   * strings, which is why the wrong one type-checked — but they mean opposite
   * things at the upper bound: `DateRange` is an INCLUSIVE pair of
   * `YYYY-MM-DD` UTC days, while what the Explorer actually passes is
   * `resolveRange`'s output, whose `to` is an EXCLUSIVE ISO instant (an hour
   * drilled in from a chart bucket). `dateRangeBounds` already reads both
   * shapes correctly, so this is the contract catching up with the value, not
   * a behaviour change. `toDayRange` is the one conversion in the other
   * direction, for the surfaces that only speak days.
   */
  range: AbsoluteRange | null;
  /**
   * Labels a memory must ALL carry. Empty means no label filter.
   *
   * @deprecated Superseded by {@link UseMemoriesFilters.filters}, which
   * expresses the same constraint as a `label` filter with the `all` operator
   * plus five more dimensions. Kept so a caller that has not migrated still
   * works; it is folded into `filters` below rather than sent separately, so
   * there is one path to the wire.
   */
  tags?: string[];
  /**
   * The Explorer's filter bar — OR within a dimension, AND across dimensions.
   * Empty means no dimension filter.
   */
  filters?: Filter[];
  /** When true, fetches archived memories instead of active ones. */
  showArchived?: boolean;
  /**
   * "Expiring soon" horizon in days (`GET /memories?expiring_within_days=`).
   * Absent means no expiry narrowing.
   *
   * Kept as its own field rather than folded into `showArchived` because the
   * two are orthogonal on the wire, and because the archive mutations select
   * their cache pages by the BOOLEAN at key index 4 — collapsing the two into
   * one tri-state field would break that contract silently.
   */
  expiringWithinDays?: number;
}

/**
 * Fold the deprecated `tags` shorthand into the filter list.
 *
 * A `label` filter already present wins: an explicit bar beats a leftover
 * shorthand, and merging the two would silently union two selections the user
 * sees as one.
 */
function mergedFilters(filters: UseMemoriesFilters): Filter[] {
  const explicit = normalizeFilters(filters.filters ?? []);
  const legacy = normalizeTags(filters.tags);
  if (legacy.length === 0 || explicit.some((f) => f.field === 'label')) return explicit;
  return normalizeFilters([...explicit, { field: 'label', operator: 'all', values: legacy }]);
}

/**
 * `useInfiniteQuery` over the `listMemories` server action.
 *
 * Changing any filter key resets pagination automatically because the query
 * key changes — no manual "reset cursor on filter change" bookkeeping needed.
 * `fetchNextPage` drives the "Load more" control in `LoreExplorer`.
 */
export function useMemories(filters: UseMemoriesFilters) {
  const bar = mergedFilters(filters);
  return useInfiniteQuery<MemoryPage>({
    // The filter bar is APPENDED, never inserted: the archive mutations select
    // archived vs active pages by `queryKey[4]`, so the first five segments are
    // a fixed contract. Extend this key at the end only. It REPLACES the old
    // `tags` segment (index 5) rather than sitting beside it — the deprecated
    // `tags` input is folded into the bar by `mergedFilters`, so two segments
    // would encode one constraint twice and split the cache for no reason.
    queryKey: [
      'memories',
      filters.scope,
      filters.search,
      filters.range,
      filters.showArchived ?? false,
      bar,
      // APPENDED, per the rule above: index 4 must stay the archived boolean the
      // mutations match on. Present in the key because the active and the
      // expiring views are different result sets over the same population — a
      // key that ignored it would serve the unfiltered page when the user
      // switched to Expiring and never refetch.
      filters.expiringWithinDays ?? null,
    ],
    queryFn: ({ pageParam }) => {
      const args: MemoryFilters = {
        scope: filters.scope ?? undefined,
        search: filters.search || undefined,
        range: filters.range,
        filters: bar,
        cursor: pageParam as string | null,
        showArchived: filters.showArchived,
        expiringWithinDays: filters.expiringWithinDays,
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
      // Whether success or failure, sync the scope tree, the facet catalog,
      // and the legacy lore cache.
      void queryClient.invalidateQueries({ queryKey: ['lore-scopes'] });
      void queryClient.invalidateQueries({ queryKey: ['lore-facets'] });
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
      void queryClient.invalidateQueries({ queryKey: ['lore-facets'] });
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
      void queryClient.invalidateQueries({ queryKey: ['memory-total'] });
      // Invalidate active list so the restored memory reappears.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'memories' && q.queryKey[4] === false,
      });
    },
  });
}
