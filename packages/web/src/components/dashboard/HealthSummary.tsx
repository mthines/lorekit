'use client';

/**
 * HealthSummary — the "is this basically fine" verdict, rendered ABOVE the
 * Friction/Latency/Coverage panels it summarizes.
 *
 * Insights previously opened with three diagnostic panels and no headline: a
 * reader had to parse Friction, Latency, and Coverage gaps individually to
 * answer "should I be worried" — the most common question anyone opening an
 * operational page actually has. This reads the SAME `/usage` fetch
 * (`summary.total_events`/`by_outcome`, already summed server-side) plus the
 * already-computed top `FailureRow`, so the verdict costs no extra request
 * and cannot drift from the panels below it — see `summarizeHealth` in
 * `lib/usage-health.ts`.
 *
 * Deliberately not `AnimatedNumber` for the percentage: that component rounds
 * to whole numbers mid-tween (built for integer counts, and every existing
 * caller passes one) and this is a single fixed-window computation, not a
 * value that re-renders in response to a selection — there is nothing here
 * for the animation to indicate.
 */

import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import type { UsageSummary } from '@lorekit/schemas/usage';
import { Badge } from '@/components/ui/Badge';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { summarizeHealth, type FailureRow } from '@/lib/usage-health';

interface HealthSummaryProps {
  summary: UsageSummary;
  failures: readonly FailureRow[];
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
  healthy: { icon: CheckCircle2, color: 'text-[#34d399]', badge: 'green', label: 'Healthy' },
  degraded: { icon: AlertTriangle, color: 'text-[#f5a623]', badge: 'amber', label: 'Degraded' },
  unhealthy: { icon: XCircle, color: 'text-[#f87171]', badge: 'red', label: 'Unhealthy' },
};

export function HealthSummary({ summary, failures }: HealthSummaryProps) {
  const { totalCalls, successRate, topFailure } = summarizeHealth(summary, failures);

  if (totalCalls === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-sm text-[var(--color-content-secondary)]">
        No calls recorded in the last 62 days.
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
          </p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            <AnimatedNumber value={totalCalls} /> calls in the last 62 days
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
