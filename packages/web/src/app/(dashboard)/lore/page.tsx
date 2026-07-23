import type { Metadata } from 'next';
import { createServerClient } from '@/lib/supabase/server';
import { LoreExplorer } from '@/components/lore/LoreExplorer';
import type { ScopeNode } from '@/components/lore/ScopeTree';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { scopeType } from '@lorekit/core';

export const metadata: Metadata = { title: 'Lore Explorer' };

async function fetchScopesAndLessons(supabase: Awaited<ReturnType<typeof createServerClient>>) {
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

  // Build scope tree from unique scopes
  const scopeCounts = new Map<string, number>();
  for (const l of lessons) {
    scopeCounts.set(l.scope, (scopeCounts.get(l.scope) ?? 0) + 1);
  }

  // Group: global → projects → repos → branches (simplified flat tree for now)
  const scopeNodes: ScopeNode[] = Array.from(scopeCounts.entries())
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

  return { scopes: scopeNodes, lessons };
}

export default async function LorePage() {
  const supabase = await createServerClient();
  const { scopes, lessons } = await fetchScopesAndLessons(supabase);

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Browse and search your agents&apos; accumulated lessons by scope.
        </p>
      </div>

      <div className="flex-1 overflow-hidden" style={{ height: 'calc(100vh - 11rem)' }}>
        <LoreExplorer scopes={scopes} lessons={lessons} />
      </div>
    </div>
  );
}
