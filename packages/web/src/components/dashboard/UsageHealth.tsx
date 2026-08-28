'use client';

/**
 * UsageHealth — three operational diagnostics computed from `GET
 * /memories/usage`'s `by_tool` rows, none of which any surface renders today:
 *
 * 1. **Friction** — failed calls by outcome, with identical repeated failures
 *    summed into one legible row rather than left as an invisible stat.
 * 2. **Latency** — mean duration per tool + scope. A MEAN, not a percentile —
 *    `usage_events` carries no histogram, so this is labelled as such rather
 *    than implied to be a p50/p95.
 * 3. **Coverage gaps** — calls vs the records they actually found, per scope
 *    type, presented as "asked N times, found M" so a bad ratio reads as an
 *    actionable prompt (narrow the hook, or write the lore that's missing)
 *    rather than a bare fraction.
 *
 * All three come from ONE `/usage` call already fetched by `useDashboardData`
 * — no new endpoint. Pure aggregation lives in `lib/usage-health.ts`; this is
 * the display shell.
 *
 * These are DIAGNOSTICS, not the additive stat cards above them, so they are
 * deliberately NOT bound by the bars-sum-to-headline invariant those cards
 * hold — and for the same reason they get their own section rather than a
 * spot in the stat row, where that property would be implied.
 */

import { AlertTriangle, Timer, SearchX, Info } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Badge } from '@/components/ui/Badge';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import {
  failuresByToolOutcome,
  meanLatencyByToolScope,
  coverageGapsByScopeType,
  type CoverageGapRow,
} from '@/lib/usage-health';

interface UsageHealthProps {
  rows: UsageStatRow[];
}

/** Below this many records per call, a scope type is called out as a gap. */
const COVERAGE_GAP_THRESHOLD = 1;

function SectionHeading({ icon: Icon, title, tooltip }: { icon: typeof AlertTriangle; title: string; tooltip: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="size-3.5 text-[var(--color-content-tertiary)]" aria-hidden />
      <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">{title}</h3>
      <Tooltip content={tooltip} side="top" align="left">
        <Info className="size-3 shrink-0 text-[var(--color-content-tertiary)] opacity-60" aria-hidden />
      </Tooltip>
    </div>
  );
}

export function UsageHealth({ rows }: UsageHealthProps) {
  const failures = failuresByToolOutcome(rows);
  const latency = meanLatencyByToolScope(rows).slice(0, 6);
  const coverage = coverageGapsByScopeType(rows).filter((r) => r.event_count > 0);

  if (rows.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 sm:grid-cols-3">
      {/* Friction */}
      <div>
        <SectionHeading
          icon={AlertTriangle}
          title="Friction"
          tooltip="Calls in this window that did not succeed, grouped by tool and outcome. A large count on one row is the same failure repeating, not many different ones."
        />
        {failures.length === 0 ? (
          <p className="text-xs text-[var(--color-content-tertiary)]">No failed calls in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {failures.slice(0, 5).map((f) => (
              <li key={`${f.tool_name}\u0000${f.outcome}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-mono text-[var(--color-content-secondary)]" title={f.tool_name}>
                  {f.tool_name}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Badge variant="red">{f.outcome}</Badge>
                  <span className="font-mono text-[var(--color-content-tertiary)]">×{f.event_count}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Latency */}
      <div>
        <SectionHeading
          icon={Timer}
          title="Latency"
          tooltip="Mean duration per tool and scope type in this window (total_duration_ms ÷ calls) — a MEAN, not a percentile. usage_events carries no histogram, so this cannot show a p50/p95."
        />
        {latency.length === 0 ? (
          <p className="text-xs text-[var(--color-content-tertiary)]">No timed calls in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {latency.map((l) => (
              <li key={`${l.tool_name}\u0000${l.scope_type}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-mono text-[var(--color-content-secondary)]" title={`${l.tool_name} · ${l.scope_type}`}>
                  {l.tool_name} <span className="text-[var(--color-content-tertiary)]">· {l.scope_type}</span>
                </span>
                <span className="shrink-0 font-mono text-[var(--color-content-tertiary)]">{Math.round(l.meanMs)} ms</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Coverage gaps */}
      <div>
        <SectionHeading
          icon={SearchX}
          title="Coverage gaps"
          tooltip="Calls vs the records they actually found, per scope type — a low ratio means agents keep asking a scope for lore that isn't there. Unrecognised scope_type values (legacy free-text) are bucketed as 'other' rather than shown as their own row."
        />
        {coverage.length === 0 ? (
          <p className="text-xs text-[var(--color-content-tertiary)]">No scoped reads in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {coverage.map((c) => (
              <CoverageGapItem key={c.scope_type} row={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CoverageGapItem({ row }: { row: CoverageGapRow }) {
  const isGap = row.recordsPerCall < COVERAGE_GAP_THRESHOLD;
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="font-mono text-[var(--color-content-secondary)]">{row.scope_type}</span>
      <span className={`font-mono ${isGap ? 'text-amber-400' : 'text-[var(--color-content-tertiary)]'}`}>
        asked {row.event_count.toLocaleString()}× → found {row.record_count.toLocaleString()}
      </span>
    </li>
  );
}
