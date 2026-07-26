import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { scopeType } from '@/lib/scope';
import { ownerFromMemoryRow } from '@/lib/ownership';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';

export interface LoreData {
  scopes: ScopeNode[];
  lessons: LessonEntry[];
}

async function fetchLoreData(): Promise<LoreData> {
  const supabase = createClient();

  // org_id/created_by/updated_by (00015) plus the embedded org name/slug
  // (memories_org_id_fkey, 00013) surface a memory's ownership — org?: null
  // for personal lore, the resolved name/slug for org-owned lore.
  const { data, error } = await supabase
    .from('memories')
    .select('scope,key,value,tags,created_at,updated_at,archived_at,source_agent,trigger,org_id,created_by,updated_by,orgs(name,slug)')
    .is('archived_at', null)
    // Order by creation date so memories migrated with a backdated created_at
    // appear at their correct original position, not the migration time.
    .order('created_at', { ascending: false })
    .limit(500);

  if (error || !data) return { scopes: [], lessons: [] };

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
