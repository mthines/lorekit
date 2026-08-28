'use client';

/**
 * AgentBreakdown — "who is reading" (by `client`) and "which agent family"
 * (by `kind` × `host`), from `GET /memories/usage`'s `by_tool` rows
 * (migration 00079 added `client`/`kind`/`host` to the group-by).
 *
 * Both dimensions have sat on `usage_events` unexposed for months — `client`
 * since migration 00054, `kind`/`host` since 00056 — and the client
 * dimension only became meaningful once both transports stopped leaving an
 * unattributed call as NULL (PR B1's per-transport default). Best read
 * together with that PR: before it, this panel's `client` breakdown is one
 * large `null` bucket.
 *
 * Diagnostics, like `UsageHealth` — not bound by the stat row's
 * bars-sum-to-headline invariant, so it gets its own section too.
 */

import { Users, Layers } from 'lucide-react';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { readsByClient, readsByAgentFamily } from '@/lib/usage-health';

interface AgentBreakdownProps {
  rows: UsageStatRow[];
}

export function AgentBreakdown({ rows }: AgentBreakdownProps) {
  const byClient = readsByClient(rows);
  const byFamily = readsByAgentFamily(rows).slice(0, 6);

  if (rows.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 sm:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Users className="size-3.5 text-[var(--color-content-tertiary)]" aria-hidden />
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Who is reading
          </h3>
        </div>
        {byClient.length === 0 ? (
          <p className="text-xs text-[var(--color-content-tertiary)]">No calls in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {byClient.map((c) => (
              <li key={c.client ?? 'unattributed'} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-[var(--color-content-secondary)]">{c.client ?? 'unattributed'}</span>
                <span className="font-mono text-[var(--color-content-tertiary)]">
                  {c.event_count.toLocaleString()} calls · {c.record_count.toLocaleString()} records
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Layers className="size-3.5 text-[var(--color-content-tertiary)]" aria-hidden />
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Agent family
          </h3>
        </div>
        {byFamily.length === 0 ? (
          <p className="text-xs text-[var(--color-content-tertiary)]">No taxonomy-tagged calls in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {byFamily.map((f) => (
              <li key={`${f.kind}\u0000${f.host}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-mono text-[var(--color-content-secondary)]">
                  {f.kind ?? '?'} <span className="text-[var(--color-content-tertiary)]">· {f.host ?? '?'}</span>
                </span>
                <span className="shrink-0 font-mono text-[var(--color-content-tertiary)]">
                  {f.event_count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
