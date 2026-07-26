'use client';

import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { listMemories, type MemoryFilters, type MemoryPage } from '@/lib/lore';
import type { DateRange } from '@/components/ui/DateRangePicker';

export interface LoreData {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
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

  const { data, error } = await supabase
    .from('memories')
    .select('scope,key,value,tags,created_at,updated_at,archived_at,source_agent,trigger')
    .is('archived_at', null)
    // Order by creation date so memories migrated with a backdated created_at
    // appear at their correct original position, not the migration time.
    .order('created_at', { ascending: false })
    .limit(500);

  if (error || !data) return { scopes: [], lessons: [] };

  const lessons: LessonEntry[] = data.map((row: Record<string, unknown>) => ({
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
  }));

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

  return { scopes, lessons };
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
    queryKey: ['memories', filters.scope, filters.search, filters.range],
    queryFn: ({ pageParam }) => {
      const args: MemoryFilters = {
        scope: filters.scope ?? undefined,
        search: filters.search || undefined,
        range: filters.range,
        cursor: pageParam as string | null,
      };
      return listMemories(args);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    // Lore explorer is read-heavy — 90 s matches the scope-tree stale time.
    staleTime: 90_000,
  });
}
