'use client';

/**
 * RunsList — the payoff view for `GET /memories/usage?correlation_id=`: that
 * filters TO one run; this is how a reader discovers which runs exist at
 * all — local sessions, CI jobs, and PR automations (`session_kind`,
 * migration 00082), from `GET /memories/usage/runs` (migration 00083).
 *
 * Each row expands into a drill-down calling the SAME `GET /memories/usage`
 * every other usage view uses, filtered to that one `correlation_id` — the
 * literal answer to "was this lore read in a local session, CI, or a PR
 * automation".
 *
 * Keyset-paginated: `nextCursor` from the last page feeds the next request.
 * `range` is captioned rather than implied — an unbounded request is bounded
 * server-side (90 days) and this states so, per the `UNBOUNDED_STATS_RANGE`
 * posture the Explorer's own stats header uses.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, GitPullRequest, Bot, HelpCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useUsageRuns, useRunUsage } from '@/lib/queries/usage-runs';

const SESSION_KIND_META: Record<string, { label: string; icon: typeof Terminal; variant: 'blue' | 'purple' | 'green' | 'default' }> = {
  local: { label: 'Local session', icon: Terminal, variant: 'blue' },
  ci: { label: 'CI job', icon: Bot, variant: 'green' },
  pr: { label: 'PR automation', icon: GitPullRequest, variant: 'purple' },
  unknown: { label: 'Unknown', icon: HelpCircle, variant: 'default' },
};

function SessionKindBadge({ kind }: { kind: string | null }) {
  const meta = kind ? SESSION_KIND_META[kind] : undefined;
  const Icon = meta?.icon ?? HelpCircle;
  return (
    <Badge variant={meta?.variant ?? 'default'} className="normal-case">
      <Icon className="mr-1 size-3" aria-hidden />
      {meta?.label ?? kind ?? 'unattributed'}
    </Badge>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunsList() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const { data, isLoading, isError } = useUsageRuns(cursor);
  const [expanded, setExpanded] = useState<string | null>(null);

  const runs = data?.runs ?? [];

  function handleNextPage() {
    if (!data?.next_cursor) return;
    setCursorHistory((h) => [...h, cursor]);
    setCursor(data.next_cursor);
  }

  function handlePrevPage() {
    setCursorHistory((h) => {
      const prev = h[h.length - 1] ?? null;
      setCursor(prev);
      return h.slice(0, -1);
    });
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
        ))}
      </div>
    );
  }

  // A failed request is NOT an empty account. `GET /memories/usage/runs?limit=20`
  // 400d for as long as its `limit` was validated as a bare number, and this
  // panel reported that as "No runs recorded yet" — an explanation of why there
  // is no data, offered for a request that never returned any.
  if (isError) {
    return (
      <p className="text-sm text-[var(--color-content-secondary)]">
        Failed to load runs. Please refresh the page to try again.
      </p>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="text-sm text-[var(--color-content-secondary)]">
        No runs recorded yet. A run appears here once a CLI call, hook invocation, or CI job
        carries a correlation id — set explicitly via <code className="font-mono">LOREKIT_CORRELATION_ID</code>,
        or derived automatically from a CI/PR environment.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {data && (
        <p className="text-xs text-[var(--color-content-tertiary)]">
          Runs seen between {new Date(data.range.since).toLocaleDateString()} and{' '}
          {new Date(data.range.until).toLocaleDateString()}.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {runs.map((run) => (
          <RunRow
            key={run.correlation_id}
            run={run}
            expanded={expanded === run.correlation_id}
            onToggle={() => setExpanded((e) => (e === run.correlation_id ? null : run.correlation_id))}
          />
        ))}
      </ul>
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={cursorHistory.length === 0}
          analyticsId="runs.prev-page"
          onClick={handlePrevPage}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!data?.next_cursor}
          analyticsId="runs.next-page"
          onClick={handleNextPage}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: {
    correlation_id: string;
    session_kind: string | null;
    first_seen: string;
    last_seen: string;
    read_events: number;
    records_read: number;
    write_events: number;
    distinct_scopes: number;
    total_duration_ms: number;
  };
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: usage, isLoading } = useRunUsage(expanded ? run.correlation_id : null);

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full min-h-11 items-center gap-3 px-3 py-2.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        )}
        <SessionKindBadge kind={run.session_kind} />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-content-secondary)]">
          {run.correlation_id}
        </code>
        <span className="shrink-0 text-xs text-[var(--color-content-tertiary)]">
          {new Date(run.last_seen).toLocaleString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-2.5 text-xs">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <dt className="text-[var(--color-content-tertiary)]">Read events</dt>
              <dd className="font-mono text-[var(--color-content-secondary)]">{run.read_events.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-content-tertiary)]">Records read</dt>
              <dd className="font-mono text-[var(--color-content-secondary)]">{run.records_read.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-content-tertiary)]">Write events</dt>
              <dd className="font-mono text-[var(--color-content-secondary)]">{run.write_events.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-content-tertiary)]">Scopes touched</dt>
              <dd className="font-mono text-[var(--color-content-secondary)]">{run.distinct_scopes.toLocaleString()}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[var(--color-content-tertiary)]">
            {new Date(run.first_seen).toLocaleString()} → {new Date(run.last_seen).toLocaleString()} ·{' '}
            {formatDuration(run.total_duration_ms)} total
          </p>
          {isLoading ? (
            <div className="mt-2 h-4 w-40 animate-pulse rounded bg-[var(--color-bg-raised)]" />
          ) : usage ? (
            <p className="mt-2 text-[var(--color-content-tertiary)]">
              Consistent with{' '}
              <code className="font-mono">GET /memories/usage?correlation_id={run.correlation_id}</code>:{' '}
              {usage.summary.total_events.toLocaleString()} total events in that call's own window.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
