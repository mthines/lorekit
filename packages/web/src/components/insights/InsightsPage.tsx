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
 * `UsageHealth`/`AgentBreakdown` are fed by `useDashboardData()`'s
 * `usageByTool`, which is the SAME 62-day fetch the Overview already makes
 * (`lib/queries/dashboard.ts`) — it has no range picker of its own today, so
 * this page does not invent one for it; the section caption says the window
 * outright instead of implying a control that would do nothing.
 *
 * `ScopeConsumption` DOES have a real per-scope window (it drives a
 * leaderboard, not a fixed diagnostic), so it gets its own local range
 * picker — deliberately not shared with the page as a whole, because nothing
 * else on this page would react to it, and a shared control that only moves
 * one section is the misleading-UI failure mode this codebase avoids
 * elsewhere (see the Explorer's per-card scope-follows-filters table).
 *
 * `HotColdLore` and `RunsList` are account-wide/self-paginated and take no
 * window at all — "what's gone stale" and "which runs exist" are library-wide
 * questions, not windowed ones.
 */

import { useMemo, useState } from 'react';
import { Activity, Users, Layers, Flame, PlayCircle } from 'lucide-react';
import { HealthSummary } from '@/components/dashboard/HealthSummary';
import { UsageHealth } from '@/components/dashboard/UsageHealth';
import { AgentBreakdown } from '@/components/dashboard/AgentBreakdown';
import { ScopeConsumption } from '@/components/lore/ScopeConsumption';
import { HotColdLore } from '@/components/lore/HotColdLore';
import { RunsList } from '@/components/settings/RunsList';
import { RangePicker } from '@/components/ui/RangePicker';
import { useDashboardData } from '@/lib/queries/dashboard';
import { failuresByToolOutcome } from '@/lib/usage-health';
import { effectiveStatsRange, statsWindow } from '@/lib/queries/explorer-stats';
import type { RangePreset, TimeRange } from '@/lib/time-range';

const SCOPE_CONSUMPTION_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', 'all'];
const DEFAULT_SCOPE_CONSUMPTION_RANGE: TimeRange = { preset: '30d' };

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

  const { data, isLoading, isError } = useDashboardData();
  const usageByTool = useMemo(() => data?.usageByTool ?? [], [data]);
  // Shared with the Operational health section below, which computes its own
  // failures/latency/coverage from the same rows — reused here rather than
  // reading a second time so the headline can never disagree with the panel
  // that backs it.
  const failures = useMemo(() => failuresByToolOutcome(usageByTool), [usageByTool]);

  return (
    <div className="flex max-w-page flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Insights</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Dig deeper into your memories and how your agents are actually using them.
        </p>
      </div>

      {!isLoading && !isError && data && (
        <HealthSummary summary={data.usageSummary} failures={failures} />
      )}

      <Section
        icon={Activity}
        title="Operational health"
        description="Failures by outcome, mean latency per tool, and scopes that get asked for but come back empty — over the last 62 days."
      >
        {isLoading ? (
          <SectionSkeleton />
        ) : isError ? (
          // NEVER fold a failed request into the empty state — see HotColdLore.tsx's
          // comment on the same anti-pattern. A broken `usageByTool` fetch must read
          // as broken, not as "no usage recorded".
          <EmptySection message="Failed to load usage data. Please refresh the page to try again." />
        ) : usageByTool.length === 0 ? (
          <EmptySection message="No usage recorded in the last 62 days." />
        ) : (
          <UsageHealth rows={usageByTool} />
        )}
      </Section>

      <Section
        icon={Users}
        title="Who's reading"
        description="Reads broken down by calling surface (dashboard/CLI/MCP/API) and by agent family (kind × host) — over the last 62 days."
      >
        {isLoading ? (
          <SectionSkeleton />
        ) : isError ? (
          <EmptySection message="Failed to load usage data. Please refresh the page to try again." />
        ) : usageByTool.length === 0 ? (
          <EmptySection message="No usage recorded in the last 62 days." />
        ) : (
          <AgentBreakdown rows={usageByTool} />
        )}
      </Section>

      <Section
        icon={Layers}
        title="Scope consumption"
        description="Scopes ranked by memory records read — including the unattributed bucket, honestly labelled rather than dropped."
        trailing={
          <RangePicker
            value={scopeRange}
            onChange={setScopeRange}
            presets={SCOPE_CONSUMPTION_PRESETS}
            nowIso={nowIso}
          />
        }
      >
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
          <ScopeConsumption since={scopeWindow.since} until={scopeWindow.until} />
        </div>
      </Section>

      <Section
        icon={Flame}
        title="Hot & cold lore"
        description="Memories ranked by how often they've actually been read back — the prune-list input the lorekit-groom skill consumes. Account-wide, all time."
      >
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
          <HotColdLore />
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
