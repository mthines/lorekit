'use client';

/**
 * UsageAttribution — "who is reading" (by `client`) and "reads by agent
 * family" (by `kind` × `host`), both dimensions `usage_events` has stored
 * since migrations 00054/00056 and both unanswerable from `/memories/usage`
 * until migration 00076 widened `lorekit_usage_stats`' group-by to include
 * them.
 *
 * Meaningful only for traffic recorded after the per-transport `client`
 * default shipped — a null-client bucket includes every request made before
 * that default existed, not only genuinely unattributed ones, so the caption
 * says so rather than implying the whole null bucket is "unknown agents".
 */

import { Badge } from '@/components/ui/Badge';
import { useUsageByTool } from '@/lib/queries/usage-attribution';
import { attributionByClient, attributionByAgentFamily } from '@/lib/usage-attribution';

interface UsageAttributionProps {
  since: string;
  until: string;
}

const CLIENT_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  cli: 'CLI',
  mcp: 'MCP',
  api: 'API',
};

const CLIENT_BADGE_VARIANT: Record<string, 'blue' | 'green' | 'purple' | 'amber'> = {
  dashboard: 'blue',
  cli: 'green',
  mcp: 'purple',
  api: 'amber',
};

export function UsageAttribution({ since, until }: UsageAttributionProps) {
  const { data: rows, isLoading } = useUsageByTool(since, until);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-6 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
        ))}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return <p className="text-xs text-[var(--color-content-tertiary)]">No usage recorded in this window.</p>;
  }

  const byClient = attributionByClient(rows);
  const byAgentFamily = attributionByAgentFamily(rows).slice(0, 6);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          Who is reading
        </h3>
        <p className="mb-2 text-[10px] text-[var(--color-content-tertiary)] opacity-70">
          Unattributed includes traffic from before per-transport attribution shipped, not only genuinely unknown callers.
        </p>
        <ul className="flex flex-col gap-1.5">
          {byClient.map(({ client, event_count }) => (
            <li key={client ?? 'unattributed'} className="flex items-center justify-between gap-2 text-xs">
              {client ? (
                <Badge variant={CLIENT_BADGE_VARIANT[client] ?? 'default'}>{CLIENT_LABELS[client] ?? client}</Badge>
              ) : (
                <Badge variant="default">unattributed</Badge>
              )}
              <span className="font-mono text-[var(--color-content-tertiary)]">{event_count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          Reads by agent family
        </h3>
        <ul className="flex flex-col gap-1.5">
          {byAgentFamily.map(({ kind, host, event_count }) => (
            <li key={`${kind ?? ''}\u0000${host ?? ''}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-mono text-[var(--color-content-secondary)]">
                {kind ?? host ? `${kind ?? 'unknown'} · ${host ?? 'unknown'}` : 'unattributed'}
              </span>
              <span className="shrink-0 font-mono text-[var(--color-content-tertiary)]">{event_count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
