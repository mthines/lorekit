'use client';

import { useQuery, useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import { ownerFromMemoryRow } from '@/lib/ownership';
import { aggregateByDay } from '@/lib/aggregations';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { listMemories, archiveLesson, restoreLesson, type MemoryFilters, type MemoryPage } from '@/lib/lore';
import type { DateRange } from '@/components/ui/DateRangePicker';
import type { ActivityEvent } from '@/components/activity/ActivityFeed';

export interface LoreData {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
  /** Heatmap series derived from the same lesson rows — no extra fetch. */
  heatmapData: { date: string; count: number }[];
  /** Time-ordered feed events derived from the same lesson rows. */
  feedEvents: ActivityEvent[];
}

// ---------------------------------------------------------------------------
// Scope-tree-only fetch (used by the Lore Explorer sidebar).
// Fetches the minimal data needed to render the scope tree: unique scopes and
// their memory counts. This remains a lightweight client query so the tree
// renders immediately while the paginated lesson list streams in separately.
// ---------------------------------------------------------------------------

async function fetchScopes(): Promise<ScopeNode[]> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('memories')
    .select('scope')
    .is('archived_at', null)
    .order('scope', { ascending: true });

  if (error || !data) return [];

  const scopeCounts = new Map<string, number>();
  for (const row of data as { scope: string }[]) {
    scopeCounts.set(row.scope, (scopeCounts.get(row.scope) ?? 0) + 1);
  }

  return Array.from(scopeCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, count]) => {
      const parts = scope.split('::');
      return {
        scope,
        type: scopeType(scope),
        label: parts[parts.length - 1] ?? scope,
        count,
      };
    });
}

export function useScopeTree() {
  return useQuery<ScopeNode[]>({
    queryKey: ['lore-scopes'],
    queryFn: fetchScopes,
    // Scope tree is read-heavy — keep data for 90 s before refetching.
    staleTime: 90_000,
  });
}

// ---------------------------------------------------------------------------
// Legacy: full data fetch (scopes + lessons in one shot, no pagination).
// Kept for back-compat with any remaining call sites; prefer `useScopeTree` +
// `useMemories` for new code.
// ---------------------------------------------------------------------------

async function fetchLoreData(): Promise<LoreData> {
  const supabase = createClient();

  // org_id/created_by/updated_by (00015) plus the embedded org name/slug
  // (memories_org_id_fkey, 00013) surface a memory's ownership — org?: null
  // for personal lore, the resolved name/slug for org-owned lore.
  const { data, error } = await supabase
    .from('memories')
    .select('id,scope,key,value,tags,created_at,updated_at,archived_at,source_agent,trigger,org_id,created_by,updated_by,orgs(name,slug)')
    .is('archived_at', null)
    // Order by creation date so memories migrated with a backdated created_at
    // appear at their correct original position, not the migration time.
    .order('created_at', { ascending: false })
    .limit(500);

  if (error || !data) return { scopes: [], lessons: [], heatmapData: [], feedEvents: [] };

  const lessons: LessonEntry[] = data.map((row: Record<string, unknown>) => {
    const orgId = (row.org_id as string | null) ?? null;
    const orgEmbed = row.orgs as { name: string; slug: string } | null;
    return {
      scope: row.scope as string,
      scope_type: scopeType(row.scope as string),
      key: row.key as string,
      value: row.value as string,
      tags: (row.tags as string[]) ?? [],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      archived_at: (row.archived_at as string | null) ?? null,
      source_agent: row.source_agent as string | null,
      trigger: row.trigger as string | null,
      org_id: orgId,
      created_by: (row.created_by as string | null) ?? null,
      updated_by: (row.updated_by as string | null) ?? null,
      org: ownerFromMemoryRow({
        org_id: orgId,
        org: orgEmbed && orgId ? { id: orgId, name: orgEmbed.name } : null,
      }),
    };
  });

  // Build scope tree from unique scopes.
  const scopeCounts = new Map<string, number>();
  for (const l of lessons) {
    scopeCounts.set(l.scope, (scopeCounts.get(l.scope) ?? 0) + 1);
  }

  const scopes: ScopeNode[] = Array.from(scopeCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, count]) => {
      const parts = scope.split('::');
      return {
        scope,
        type: scopeType(scope),
        label: parts[parts.length - 1] ?? scope,
        count,
      };
    });

  // Derive heatmap data from the same rows — normalise to UTC ISO date so
  // timestamps with timezone offsets don't produce mismatched heatmap keys.
  const heatmapData = aggregateByDay(
    lessons.map((l) => ({ created_at: new Date(l.created_at).toISOString() })),
  );

  // Derive time-ordered feed events (same shape as the old /activity page).
  const feedEvents: ActivityEvent[] = data.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    scope: row.scope as string,
    scope_type: scopeType(row.scope as string),
    key: row.key as string,
    value_preview: ((row.value as string) ?? '').slice(0, 120),
    source_agent: row.source_agent as string | null,
    trigger: row.trigger as string | null,
    tags: (row.tags as string[]) ?? [],
    created_at: row.created_at as string,
  }));

  return { scopes, lessons, heatmapData, feedEvents };
}

export function useLoreData() {
  return useQuery<LoreData>({
    queryKey: ['lore'],
    queryFn: fetchLoreData,
    // Lore explorer is read-heavy — keep data for 90 s before refetching.
    staleTime: 90_000,
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
    queryKey: ['memories', filters.scope, filters.search, filters.range, filters.showArchived ?? false],
    queryFn: ({ pageParam }) => {
      const args: MemoryFilters = {
        scope: filters.scope ?? undefined,
        search: filters.search || undefined,
        range: filters.range,
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
      // Whether success or failure, sync the scope tree and legacy lore cache.
      void queryClient.invalidateQueries({ queryKey: ['lore-scopes'] });
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
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
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
      // Invalidate active list so the restored memory reappears.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'memories' && q.queryKey[4] === false,
      });
    },
  });
}
