import type { PlanUsage } from '@/lib/plan';

interface PlanUsageBarProps {
  usage: PlanUsage;
}

/**
 * Horizontal progress bar showing active memory count vs. the plan ceiling,
 * with an optional personal / org breakdown below the numbers.
 *
 * A progress bar (not a chart) is deliberate: charts imply time-series data;
 * a bar gives the spatial intuition at a glance without pulling in a charting
 * library.
 *
 * Accessible: uses <progress> semantics + aria labels so screen readers
 * announce the percentage without reading raw numbers.
 */
export function PlanUsageBar({ usage }: PlanUsageBarProps) {
  const { count, limit, personalCount, orgCount } = usage;
  const pct = limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 0;

  // Accent → warning colour at 80 %+ to prompt the user to archive before the cap hits.
  const barClass =
    pct >= 90
      ? 'bg-red-500'
      : pct >= 80
        ? 'bg-amber-500'
        : 'bg-[var(--color-accent)]';

  const showBreakdown = orgCount > 0;

  return (
    <div className="space-y-1.5">
      {/* Bar */}
      <div
        role="progressbar"
        aria-label="Memory usage"
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={limit}
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-elevated)]"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Total count + percentage */}
      <div className="flex items-center justify-between text-xs text-[var(--color-content-secondary)]">
        <span>
          <span className="font-semibold text-[var(--color-content-primary)]">
            {count.toLocaleString()}
          </span>{' '}
          / {limit.toLocaleString()} memories used
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>

      {/* Personal vs org breakdown — only shown when the user belongs to at least one org */}
      {showBreakdown && (
        <p className="text-[11px] text-[var(--color-content-tertiary)]">
          <span className="font-medium text-[var(--color-content-secondary)]">
            {personalCount.toLocaleString()}
          </span>{' '}
          personal
          {' · '}
          <span className="font-medium text-[var(--color-content-secondary)]">
            {orgCount.toLocaleString()}
          </span>{' '}
          via orgs
        </p>
      )}
    </div>
  );
}
