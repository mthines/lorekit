'use client';

/**
 * HealthSummary — the "is this basically fine" verdict, rendered ABOVE the
 * Friction/Latency/Coverage panels it summarizes.
 *
 * Insights previously opened with three diagnostic panels and no headline: a
 * reader had to parse Friction, Latency, and Coverage gaps individually to
 * answer "should I be worried" — the most common question anyone opening an
 * operational page actually has. This reads `rows` — the SAME `/usage` fetch
 * `UsageHealth` renders below, already narrowed to agent traffic by the
 * caller (`excludeDashboardReads`) — plus the already-computed top
 * `FailureRow`, so the verdict cannot drift from the panels below it. See
 * `summarizeHealth` in `lib/usage-health.ts`.
 *
 * `previousRows`/the `TrendChip` answer "is my agent doing better than last
 * period" — see `healthTrend`. `null` from it (an empty previous window) just
 * omits the chips; there is nothing dishonest a young account's first busy
 * week could show instead.
 *
 * Deliberately not `AnimatedNumber` for the percentage: that component rounds
 * to whole numbers mid-tween (built for integer counts, and every existing
 * caller passes one) and this is a single fixed-window computation, not a
 * value that re-renders in response to a selection — there is nothing here
 * for the animation to indicate.
 */

import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { Badge } from '@/components/ui/Badge';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { TrendChip } from '@/components/dashboard/StatCard';
import { summarizeHealth, healthTrend, type FailureRow } from '@/lib/usage-health';

interface HealthSummaryProps {
  /** Current window's rows — already dashboard-excluded by the caller. */
  rows: readonly UsageStatRow[];
  /** The immediately preceding equal-length window's rows, for the trend chip. */
  previousRows: readonly UsageStatRow[];
  failures: readonly FailureRow[];
  /** The selected window as a caption fragment, e.g. "the last 7 days" (see `lib/time-range.ts#rangeCaption`). */
  rangeCaption: string;
}

/** At or above this success rate, the verdict reads as healthy (green). */
const HEALTHY_THRESHOLD = 0.99;
/** Below {@link HEALTHY_THRESHOLD} but at or above this, the verdict is a caution (amber) rather than a problem (red). */
const DEGRADED_THRESHOLD = 0.95;

type Verdict = 'healthy' | 'degraded' | 'unhealthy';

function verdictFor(successRate: number): Verdict {
  if (successRate >= HEALTHY_THRESHOLD) return 'healthy';
  if (successRate >= DEGRADED_THRESHOLD) return 'degraded';
  return 'unhealthy';
}

const VERDICT_META: Record<Verdict, { icon: typeof CheckCircle2; color: string; badge: 'green' | 'amber' | 'red'; label: string }> = {
  healthy: { icon: CheckCircle2, color: 'text-[var(--color-success)]', badge: 'green', label: 'Healthy' },
  degraded: { icon: AlertTriangle, color: 'text-[var(--color-warning)]', badge: 'amber', label: 'Degraded' },
  unhealthy: { icon: XCircle, color: 'text-[var(--color-error)]', badge: 'red', label: 'Unhealthy' },
};

export function HealthSummary({ rows, previousRows, failures, rangeCaption }: HealthSummaryProps) {
  const { totalCalls, successRate, topFailure } = summarizeHealth(rows, failures);
  const trend = healthTrend(rows, previousRows);

  if (totalCalls === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-sm text-[var(--color-content-secondary)]">
        No calls recorded in {rangeCaption}.
      </p>
    );
  }

  const verdict = verdictFor(successRate);
  const { icon: Icon, color, badge, label } = VERDICT_META[verdict];
  const successPct = Math.round(successRate * 1000) / 10;

  return (
    // Always a vertical stack, never a wrapping row: a side-by-side layout
    // (flex-wrap + border-l as the divider) left a stray, disconnected
    // vertical line whenever the failure line was long enough to wrap onto
    // its own row — the border had nothing to its left there. A fixed
    // top-border divider on its own row has no such failure mode.
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <div className="flex items-center gap-2.5">
        <Icon className={`size-5 shrink-0 ${color}`} aria-hidden />
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--color-content-primary)]">
            <Badge variant={badge}>{label}</Badge>
            {successPct}% of calls succeeded
            {trend && (
              <span
                className={`text-xs font-medium tabular-nums ${
                  trend.successRateDeltaPct > 0
                    ? 'text-[var(--color-success)]'
                    : trend.successRateDeltaPct < 0
                      ? 'text-[var(--color-error)]'
                      : 'text-[var(--color-content-tertiary)]'
                }`}
                title="Success rate vs. the immediately preceding period of equal length, in percentage points — not a percent-of-percent change."
              >
                ({trend.successRateDeltaPct > 0 ? '+' : ''}
                {trend.successRateDeltaPct}pp)
              </span>
            )}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-content-tertiary)]">
            <AnimatedNumber value={totalCalls} /> calls in {rangeCaption}
            {trend && (
              <TrendChip changePct={trend.totalCallsChangePct} title="Call volume vs. the immediately preceding period of equal length" />
            )}
          </p>
        </div>
      </div>

      {topFailure && (
        <div className="flex min-w-0 items-center gap-2 border-t border-[var(--color-border)] pt-3 text-xs">
          <Badge variant="red">{topFailure.outcome}</Badge>
          <span className="min-w-0 truncate text-[var(--color-content-secondary)]">
            Most common issue: <span className="font-mono">{topFailure.tool_name}</span> — mostly{' '}
            {topFailure.topContext.client ?? 'unattributed'} · {topFailure.topContext.scope_type}
          </span>
        </div>
      )}
    </div>
  );
}
