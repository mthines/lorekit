import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';

export interface LoreData {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
}

async function fetchLoreData(): Promise<LoreData> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('memories')
    .select('scope,key,value,tags,updated_at,source_agent,trigger')
    .order('updated_at', { ascending: false })
    .limit(500);

  if (error || !data) return { scopes: [], lessons: [] };

  const lessons: LessonEntry[] = data.map((row: Record<string, unknown>) => ({
    scope: row.scope as string,
    scope_type: scopeType(row.scope as string),
    key: row.key as string,
    value: row.value as string,
    tags: (row.tags as string[]) ?? [],
    updated_at: row.updated_at as string,
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
