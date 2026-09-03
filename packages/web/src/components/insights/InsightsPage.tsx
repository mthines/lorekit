'use client';

/**
 * InsightsPage — the single place to dig into "how is my lore actually being
 * used", replacing four panels that used to be scattered across two other
 * pages:
 *
 *   - Operational health (friction/latency/coverage) and "who's reading"
 *     (client/kind/host) used to live at the bottom of the Overview.
 *   - Scope consumption and hot/cold lore used to live at the bottom of the
 *     Lore Explorer.
 *
 * Overview stays the at-a-glance summary and the Explorer stays focused on
 * finding and editing lessons; this page is where a reader comes on purpose
 * to understand consumption, not somewhere they scroll past on the way to
 * something else.
 *
 * ## Two different windows, captioned rather than blurred
 *
 * `HealthSummary`/`UsageHealth`/`AgentBreakdown` share ONE range control (the
 * "Agent activity" section's `RangePicker`) and ONE fetch
 * (`lib/queries/insights-usage.ts`) — switching it moves the verdict banner,
 * the friction/latency/coverage diagnostics, and the client breakdown
 * together, so they can never describe three different periods. This is
 * distinct from the Overview's `useDashboardData()`, which fetches one FIXED
 * 62-day window once and re-buckets client-side; here the window itself is
 * the query (same reasoning as `useExplorerStats`), because a period-over-period
 * trend needs the ACTUAL preceding window, not a slice of a wider one. Presets
 * are bounded only (`24h`/`7d`/`30d`/`90d`, no `all`) for the same reason the
 * Overview's picker omits it: a trend chip needs a preceding window of equal
 * length, and "all time" has none.
 *
 * `HealthSummary`/`UsageHealth` additionally exclude dashboard-originated
 * calls (`excludeDashboardReads`) — this page's own tagline is "how your
 * agents are actually using them", and browsing the Explorer yourself is not
 * that, same principle as the Explorer's own "Memories retrieved" cards
 * (migration 00054). `AgentBreakdown`'s "who is reading" deliberately keeps
 * the full row set — dashboard included — since showing that split IS its job.
 *
 * `ScopeConsumption` has its OWN separate window (it drives a leaderboard, not
 * a diagnostic) — deliberately not merged into the shared control above:
 * scope consumption and agent activity are different questions, and forcing
 * one range to answer both would make a reader's "last 7 days" selection
 * silently narrow a leaderboard they were reading as "last 30 days".
 *
 * `LoreUtilityGrid` and `RunsList` are account-wide/self-paginated and take no
 * window at all — "where does each lesson sit" and "which runs exist" are
 * library-wide questions, not windowed ones. `LoreCostHeadline` is the one
 * exception and carries its own fixed 30-day window in its own sentence, since
 * only its source (`memory_read_daily`) can be windowed at all; see its
 * docblock for why that is not a picker.
 */

import { useMemo, useState } from 'react';
import { Activity, Users, Layers, Grid2x2, PlayCircle, TrendingUp } from 'lucide-react';
import { HealthSummary } from '@/components/dashboard/HealthSummary';
import { UsageHealth } from '@/components/dashboard/UsageHealth';
import { AgentBreakdown } from '@/components/dashboard/AgentBreakdown';
import { ScopeConsumption } from '@/components/lore/ScopeConsumption';
import { LoreUtilityGrid } from '@/components/lore/LoreUtilityGrid';
import { LoreCostHeadline } from '@/components/lore/LoreCostHeadline';
import { RunsList } from '@/components/settings/RunsList';
import { RangePicker } from '@/components/ui/RangePicker';
import { useInsightsUsage } from '@/lib/queries/insights-usage';
import { failuresByToolOutcome, excludeDashboardReads } from '@/lib/usage-health';
import { effectiveStatsRange, statsWindow } from '@/lib/queries/explorer-stats';
import { rangeCaption, type RangePreset, type TimeRange } from '@/lib/time-range';

const SCOPE_CONSUMPTION_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', 'all'];
const DEFAULT_SCOPE_CONSUMPTION_RANGE: TimeRange = { preset: '30d' };

/** Bounded-only — a trend chip needs a preceding window of equal length, so "all time" is not offered here. */
const AGENT_ACTIVITY_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', '90d'];
const DEFAULT_AGENT_ACTIVITY_RANGE: TimeRange = { preset: '7d' };

/** One section: an icon-labelled heading, optional trailing control, and a body. */
function Section({
  icon: Icon,
  title,
  description,
  trailing,
  children,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-content-primary)]">
            <Icon className="size-4 text-[var(--color-content-tertiary)]" aria-hidden />
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">{description}</p>
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

export function InsightsPage() {
  // Mount-stable clock so the range picker's custom-window label and the
  // resolved query window describe the same instant across re-renders.
  const nowIso = useMemo(() => new Date().toISOString(), []);

  // ScopeConsumption's own window — local state, not URL-backed. It is the
  // one control on this page, scoped to the one section it drives; giving it
  // a shareable `?range=` would suggest the WHOLE page is filterable by it,
  // which is exactly what Section's docblock above says this page avoids.
  const [scopeRange, setScopeRange] = useState<TimeRange>(DEFAULT_SCOPE_CONSUMPTION_RANGE);
  const scopeWindow = useMemo(
    () => statsWindow(effectiveStatsRange(scopeRange, nowIso), nowIso),
    [scopeRange, nowIso],
  );

  // The shared window for HealthSummary/UsageHealth/AgentBreakdown — see the
  // module docblock for why this is a separate control from ScopeConsumption's.
  const [usageRange, setUsageRange] = useState<TimeRange>(DEFAULT_AGENT_ACTIVITY_RANGE);
  const usageRangeCaption = useMemo(() => rangeCaption(usageRange, nowIso), [usageRange, nowIso]);
  const { data: usageData, isLoading, isError } = useInsightsUsage(usageRange, nowIso);
  const currentRows = useMemo(() => usageData?.current.rows ?? [], [usageData]);
  const previousRows = useMemo(() => usageData?.previous.rows ?? [], [usageData]);
  // Agent-only view for the verdict banner and operational-health diagnostics
  // — "who is reading" below keeps the full (dashboard-included) set.
  const agentRows = useMemo(() => excludeDashboardReads(currentRows), [currentRows]);
  const agentPreviousRows = useMemo(() => excludeDashboardReads(previousRows), [previousRows]);
  // Shared with the Operational health section below, which computes its own
  // failures/latency/coverage from the same rows — reused here rather than
  // reading a second time so the headline can never disagree with the panel
  // that backs it.
  const failures = useMemo(() => failuresByToolOutcome(agentRows), [agentRows]);

  return (
    <div className="flex max-w-page flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Insights</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Dig deeper into your memories and how your agents are actually using them.
        </p>
      </div>

      {/* The bill leads. Every section below it is a volume, and a volume reads
          as health; stating the cost first is what makes the grid's verdicts
          feel worth acting on. See LoreCostHeadline for its own window. */}
      <LoreCostHeadline />

      <Section
        icon={TrendingUp}
        title="Agent activity"
        description="The verdict below, operational health, and who's reading all follow this window — switch it to compare periods. Your own dashboard browsing is excluded from the verdict and from operational health."
        trailing={
          <RangePicker
            value={usageRange}
            onChange={setUsageRange}
            presets={AGENT_ACTIVITY_PRESETS}
            nowIso={nowIso}
            // Two independent windows on one page, so neither picker may keep
            // the generic default name — see RangePicker's `label` prop.
            label="Agent activity time range"
          />
        }
      >
        {isLoading ? (
          <SectionSkeleton />
        ) : isError ? (
          <EmptySection message="Failed to load usage data. Please refresh the page to try again." />
        ) : usageData ? (
          <HealthSummary
            rows={agentRows}
            previousRows={agentPreviousRows}
            failures={failures}
            rangeCaption={usageRangeCaption}
          />
        ) : null}
      </Section>

      <Section
        icon={Activity}
        title="Operational health"
        description={`Failures by outcome, mean latency per tool, and scopes that get asked for but come back empty — in ${usageRangeCaption}, excluding dashboard browsing.`}
      >
        {isLoading ? (
          <SectionSkeleton />
        ) : isError ? (
          // NEVER fold a failed request into the empty state — see LoreUtilityGrid.tsx's
          // comment on the same anti-pattern. A broken usage fetch must read as
          // broken, not as "no usage recorded".
          <EmptySection message="Failed to load usage data. Please refresh the page to try again." />
        ) : agentRows.length === 0 ? (
          <EmptySection message={`No agent usage recorded in ${usageRangeCaption}.`} />
        ) : (
          <UsageHealth rows={agentRows} />
        )}
      </Section>

      <Section
        icon={Users}
        title="Who's reading"
        description={`Reads broken down by calling surface (dashboard/CLI/MCP/API) and by agent family (kind × host) — in ${usageRangeCaption}.`}
      >
        {isLoading ? (
          <SectionSkeleton />
        ) : isError ? (
          <EmptySection message="Failed to load usage data. Please refresh the page to try again." />
        ) : currentRows.length === 0 ? (
          <EmptySection message={`No usage recorded in ${usageRangeCaption}.`} />
        ) : (
          <AgentBreakdown rows={currentRows} />
        )}
      </Section>

      <Section
        icon={Layers}
        title="Scope consumption"
        description="Scopes ranked by memory records read — including the unattributed bucket, honestly labelled rather than dropped. Pick a scope to open it in the Explorer."
        trailing={
          <RangePicker
            value={scopeRange}
            onChange={setScopeRange}
            presets={SCOPE_CONSUMPTION_PRESETS}
            nowIso={nowIso}
            label="Scope consumption time range"
          />
        }
      >
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
          <ScopeConsumption since={scopeWindow.since} until={scopeWindow.until} />
        </div>
      </Section>

      <Section
        icon={Grid2x2}
        title="Is this lore earning its place?"
        description="Every lesson placed by how often it was DELIVERED against how often an agent deliberately CHOSE it — the ratio, not the raw read count, because 99.8% of reads are bulk ride-alongs and ranking by them ranks scope breadth. Pick a quadrant to see its lessons and hand them to lorekit-groom. Account-wide, all time."
      >
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
          <LoreUtilityGrid />
        </div>
      </Section>

      <Section
        icon={PlayCircle}
        title="Runs"
        description="An audit trail, not a health signal — every local session, CI job, and PR automation that has touched your lore, with its reads/writes/scopes at a glance. Drill into any one to see exactly what it did."
      >
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
          <RunsList />
        </div>
      </Section>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div
      className="h-32 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
      aria-hidden
    />
  );
}

function EmptySection({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-tertiary)]">
      {message}
    </p>
  );
}

/** Full-page skeleton for the Suspense fallback while the route first mounts. */
export function InsightsPageSkeleton() {
  return (
    <div className="flex max-w-page flex-col gap-8">
      <div>
        <div className="h-7 w-32 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="mt-2 h-4 w-80 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="h-5 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          <SectionSkeleton />
        </div>
      ))}
    </div>
  );
}
