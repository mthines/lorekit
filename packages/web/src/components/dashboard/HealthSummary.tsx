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
 * The verdict is TWO-DIMENSIONAL — reliability (did the calls succeed) AND
 * coverage (did the reads find anything), reported as the worse of the two by
 * `healthVerdict`, with the headline naming whichever drove it. Reliability
 * alone was the original headline and it never moved: LoreKit's API is stable
 * and no `outcome` value means "found nothing", so a healthy account read
 * "100% of calls succeeded" every day while the signal a reader came for sat
 * three columns into the section below.
 *
 * `previousRows`/the `TrendChip` answer "is my agent doing better than last
 * period" — see `healthTrend`. `null` from it (a previous window too small to
 * compare against) just omits the chips; there is nothing dishonest a young
 * account's first busy week could show instead.
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
import {
  summarizeHealth,
  healthTrend,
  healthVerdict,
  type FailureRow,
  type Verdict,
  type VerdictDriver,
} from '@/lib/usage-health';

interface HealthSummaryProps {
  /** Current window's rows — already dashboard-excluded by the caller. */
  rows: readonly UsageStatRow[];
  /** The immediately preceding equal-length window's rows, for the trend chip. */
  previousRows: readonly UsageStatRow[];
  failures: readonly FailureRow[];
  /** The selected window as a caption fragment, e.g. "the last 7 days" (see `lib/time-range.ts#rangeCaption`). */
  rangeCaption: string;
}

const VERDICT_META: Record<Verdict, { icon: typeof CheckCircle2; color: string; badge: 'green' | 'amber' | 'red'; label: string }> = {
  healthy: { icon: CheckCircle2, color: 'text-[var(--color-success)]', badge: 'green', label: 'Healthy' },
  degraded: { icon: AlertTriangle, color: 'text-[var(--color-warning)]', badge: 'amber', label: 'Degraded' },
  unhealthy: { icon: XCircle, color: 'text-[var(--color-error)]', badge: 'red', label: 'Unhealthy' },
};

/**
 * The one-sentence claim, stated about the dimension that actually DROVE the
 * verdict. `healthVerdict` reports the WORSE of reliability and coverage, so a
 * red badge sitting next to "100% of calls succeeded" would read as a
 * contradiction — the sentence has to name the half that is bad.
 *
 * One record keyed by `(driver, verdict)` rather than a conditional per
 * dimension: a new verdict level or a third driver is then a compile error
 * here, not a silently missing sentence.
 */
const HEADLINE: Record<VerdictDriver, Record<Verdict, string>> = {
  reliability: {
    healthy: 'Agent calls are succeeding',
    degraded: 'Some agent calls are failing',
    unhealthy: 'Agent calls are failing',
  },
  coverage: {
    healthy: 'Agents are finding the lore they ask for',
    degraded: 'Reads are coming back thin — under one lesson per ask',
    unhealthy: 'Agents are asking for lore and mostly finding none',
  },
};

/** One decimal, so a 93.5% success rate does not round away to a flat 94%. */
function asPercent(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

export function HealthSummary({ rows, previousRows, failures, rangeCaption }: HealthSummaryProps) {
  const { totalCalls, successRate, topFailure, coverage } = summarizeHealth(rows, failures);
  const trend = healthTrend(rows, previousRows);

  if (totalCalls === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-sm text-[var(--color-content-secondary)]">
        No agent calls recorded in {rangeCaption}.
      </p>
    );
  }

  const { verdict, driver } = healthVerdict({ successRate, coverage });
  const { icon: Icon, color, badge, label } = VERDICT_META[verdict];
  const successPct = asPercent(successRate);

  return (
    // Always a vertical stack, never a wrapping row: a side-by-side layout
    // (flex-wrap + border-l as the divider) left a stray, disconnected
    // vertical line whenever the failure line was long enough to wrap onto
    // its own row — the border had nothing to its left there. A fixed
    // top-border divider on its own row has no such failure mode.
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 size-5 shrink-0 ${color}`} aria-hidden />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--color-content-primary)]">
            <Badge variant={badge}>{label}</Badge>
            {HEADLINE[driver][verdict]}
          </p>

          {/* Both dimensions, always, as co-equal figures — the headline names
              only the one that drove the verdict, and a reader still needs to
              see the other to know whether it is fine or merely less bad.
              Reliability's percentage-point delta lives HERE, beside the rate
              it qualifies, never up in a headline that may be about coverage. */}
          <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-[var(--color-content-tertiary)]">Calls succeeded</dt>
              <dd className="font-medium tabular-nums text-[var(--color-content-secondary)]">{successPct}%</dd>
              {trend && (
                <dd
                  className={`font-medium tabular-nums ${
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
                </dd>
              )}
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-[var(--color-content-tertiary)]">Records per read</dt>
              {/* `null` coverage is an ABSENCE, not a zero — a write-only
                  window has no reads to have found anything. */}
              <dd className="font-medium tabular-nums text-[var(--color-content-secondary)]">
                {coverage ? coverage.recordsPerCall.toFixed(1) : 'no reads'}
              </dd>
              {coverage && (
                <dd className="text-[var(--color-content-tertiary)]">
                  ({coverage.recordsFound.toLocaleString()} found in {coverage.readCalls.toLocaleString()} reads)
                </dd>
              )}
            </div>
          </dl>

          <p className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-content-tertiary)]">
            <span className="flex items-center gap-1.5">
              <AnimatedNumber value={totalCalls} /> agent calls in {rangeCaption}
            </span>
            {trend && (
              <TrendChip changePct={trend.totalCallsChangePct} title="Call volume vs. the immediately preceding period of equal length" />
            )}
            <span>· your own dashboard browsing is excluded</span>
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
