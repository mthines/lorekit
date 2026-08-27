'use client';

/**
 * ScopeConsumption — scopes ranked by memory RECORDS read over the selected
 * window, from the SAME `(bucket, scope, count)` rows `GET /memories/read-activity`
 * already returns (migration 00058). The Explorer and Overview read cards sum
 * this scope axis away and chart only the total; this ranks it instead, so "who
 * is actually reading which lore" — not just "how much was read overall" —
 * becomes answerable on screen.
 *
 * ## The unattributed bucket is shown, not dropped
 *
 * ~40% of read records account-wide carry no scope at all (`null`), almost
 * entirely `memory.search` calls: `usage_events.scope` is one text column and
 * `memory.search` takes a `scopes[]` array, so the recording site
 * (`safeValidateScope`) has nothing single-valued to write (see PR B2, which
 * addresses the cause). Silently omitting that bucket here would make the bars
 * stop summing to the account's read total — the same additive invariant every
 * other stat card on this dashboard holds — so it renders as its own row,
 * honestly labelled, with a tooltip explaining why it exists.
 *
 * Pure ranking lives in `lib/scope-consumption.ts`; this component is the
 * impure shell (fetch + render).
 */

import { Info } from 'lucide-react';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { Tooltip } from '@/components/ui/Tooltip';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { useScopeConsumption } from '@/lib/queries/scope-consumption';
import { scopeType } from '@/lib/scope';

interface ScopeConsumptionProps {
  since: string;
  until: string;
  /** How many named scopes to show before folding the rest into "N more". @default 8 */
  limit?: number;
}

const DEFAULT_LIMIT = 8;

export function ScopeConsumption({ since, until, limit = DEFAULT_LIMIT }: ScopeConsumptionProps) {
  const { data, isLoading } = useScopeConsumption(since, until);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-6 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--color-content-tertiary)]">
        No memory reads recorded in this window.
      </p>
    );
  }

  const named = rows.filter((r) => r.scope !== null);
  const unattributed = rows.find((r) => r.scope === null) ?? null;
  const shown = named.slice(0, limit);
  const hiddenCount = named.length - shown.length;
  // Max against the FULL set (including unattributed), so every bar's width is
  // relative to the same scale — the unattributed bar is often the largest.
  const max = Math.max(...rows.map((r) => r.count), 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          Scope consumption
        </h3>
        <span className="text-xs text-[var(--color-content-tertiary)]">
          <AnimatedNumber value={total} /> records read
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {shown.map((row) => (
          <ScopeConsumptionRow key={row.scope} scope={row.scope} count={row.count} max={max} />
        ))}

        {hiddenCount > 0 && (
          <li className="text-xs text-[var(--color-content-tertiary)]">
            +{hiddenCount} more scope{hiddenCount === 1 ? '' : 's'}
          </li>
        )}

        {/* Always last, regardless of rank, so the "everything you can name" set
            reads before the "attribution gap" row — ranking it by count could
            otherwise put it first and read as the headline finding rather than a
            caveat on the ones above it. */}
        {unattributed && (
          <ScopeConsumptionRow
            scope={null}
            count={unattributed.count}
            max={max}
            tooltip="Records read by a call that could not be attributed to one scope — mostly memory.search, which accepts a list of scopes rather than one. Included so these bars still sum to the total above."
          />
        )}
      </ul>
    </div>
  );
}

function ScopeConsumptionRow({
  scope,
  count,
  max,
  tooltip,
}: {
  scope: string | null;
  count: number;
  max: number;
  tooltip?: string;
}) {
  const widthPct = Math.max((count / max) * 100, 2);
  return (
    <li className="flex items-center gap-2 text-xs">
      <div className="flex w-32 shrink-0 items-center gap-1.5 sm:w-44">
        {scope !== null ? (
          <ScopeBadge scope={scope} type={scopeType(scope)} showIcon showType={false} label className="max-w-full truncate" />
        ) : (
          <span className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 font-mono text-[var(--color-content-tertiary)]">
            unattributed
            {tooltip && (
              <Tooltip content={tooltip} side="top" align="left">
                <Info className="size-3" aria-hidden />
              </Tooltip>
            )}
          </span>
        )}
      </div>
      <div className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-elevated)]">
        <div
          className="h-full rounded-full bg-[var(--color-accent)]"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[var(--color-content-secondary)]">
        {count.toLocaleString()}
      </span>
    </li>
  );
}
