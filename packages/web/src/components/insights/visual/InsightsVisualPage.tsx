'use client';

/**
 * InsightsVisualPage — the visual first version of `/insights`, rendered when
 * `insights-visual` is on (see `InsightsView.tsx`). With it off the page is the
 * original `InsightsPage`, untouched.
 *
 * ## The page tells the loop, then shows when it moves
 *
 *   1. **The loop** — Learn → Recall → Promote → Prune as one strip
 *      (`LoopStageStrip`): is the loop turning, and where has it stalled?
 *   2. **Pulse** — written, chosen and bulk on one time axis (`PulseTimeline`).
 *   3. **Recall flow** — who asked, through which tool, from which scope type.
 *   4. **Runs** — when work starts (weekday × hour) and its shape (swimlanes),
 *      with the existing audit-trail list kept below for the drill-down.
 *   5. **Is this lore earning its place?** — the existing cost headline and
 *      utility grid, unchanged. It is the one section readers interact with
 *      today (quadrant picks and copied groom prompts), so the visual page
 *      keeps it whole rather than re-drawing it.
 *   6. **Where it is read** and **Operational health** — the existing scope
 *      leaderboard and diagnostics, now on the page's window.
 *
 * ## ONE window
 *
 * The original page carries two independent range controls. Here everything
 * windowed follows one control, so the strip, the timeline, the flow, the runs
 * and the diagnostics can never describe different periods. The census and the
 * cost headline are the exceptions and caption their own periods ("all-time",
 * "the last 30 days"), as they already do. Bounded presets only — a delta
 * needs a preceding window of equal length, and "all time" has none.
 */

import { useMemo, useState } from 'react';
import { Activity, Grid2x2, Layers, PlayCircle, Stethoscope, Workflow } from 'lucide-react';
import { HealthSummary } from '@/components/dashboard/HealthSummary';
import { UsageHealth } from '@/components/dashboard/UsageHealth';
import { LoreCostHeadline } from '@/components/lore/LoreCostHeadline';
import { LoreUtilityGrid } from '@/components/lore/LoreUtilityGrid';
import { ScopeConsumption } from '@/components/lore/ScopeConsumption';
import { RunsList } from '@/components/settings/RunsList';
import { RangePicker } from '@/components/ui/RangePicker';
import { track } from '@/lib/analytics/track';
import { rangeTelemetry } from '@/lib/analytics/lore-events';
import { loopStages, pulseBuckets, rawTotals } from '@/lib/insights-loop';
import { useInsightsLoop, useWindowRuns, MAX_RUN_PAGES } from '@/lib/queries/insights-loop';
import { useLoreUtility } from '@/lib/queries/lore-utility';
import { excludeDashboardReads, failuresByToolOutcome } from '@/lib/usage-health';
import { rangeCaption, resolveRange, type RangePreset, type TimeRange } from '@/lib/time-range';
import { LoopStageStrip } from './LoopStageStrip';
import { PulseTimeline } from './PulseTimeline';
import { RecallFlowChart } from './RecallFlowChart';
import { RunsRhythm } from './RunsRhythm';
import { RunsSwimlanes } from './RunsSwimlanes';
import { viewerTimeZone } from './format';

const PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', '90d'];
const DEFAULT_RANGE: TimeRange = { preset: '7d' };

function Section({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id?: string;
  icon: typeof Activity;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-content-primary)]">
          <Icon className="size-4 text-[var(--color-content-tertiary)]" aria-hidden />
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">{children}</div>;
}

function Skeleton({ className = 'h-32' }: { className?: string }) {
  return (
    <div className={`${className} animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]`} aria-hidden />
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-tertiary)]">
      {children}
    </p>
  );
}

const LOAD_ERROR = 'Failed to load usage data. Please refresh the page to try again.';

export function InsightsVisualPage() {
  // Mount-stable clock: the picker's label and the resolved window describe the same instant.
  const nowIso = useMemo(() => new Date().toISOString(), []);
  const timeZone = useMemo(() => viewerTimeZone(), []);
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const window = useMemo(
    () => resolveRange(range, nowIso) ?? resolveRange(DEFAULT_RANGE, nowIso) ?? { from: nowIso, to: nowIso },
    [range, nowIso],
  );
  const caption = useMemo(() => rangeCaption(range, nowIso), [range, nowIso]);

  function commitRange(next: TimeRange) {
    const { preset, spanDays } = rangeTelemetry(next, nowIso);
    track({ name: 'insights.range_changed', section: 'page', preset, ...(spanDays === undefined ? {} : { spanDays }) });
    setRange(next);
  }

  const loop = useInsightsLoop(window);
  const runs = useWindowRuns(window);
  const census = useLoreUtility({});

  const pulse = useMemo(
    () => (loop.data ? pulseBuckets(window, loop.data.unit, loop.data.current.writes, loop.data.current.reads) : []),
    [loop.data, window],
  );
  const stages = useMemo(() => {
    if (!loop.data) return null;
    const { current, previous } = loop.data;
    return loopStages(
      { totals: rawTotals(current.writes, current.reads), summary: current.usage.summary },
      { totals: rawTotals(previous.writes, previous.reads), summary: previous.usage.summary },
      census.data?.census ?? null,
    );
  }, [loop.data, census.data]);

  const usageRows = useMemo(() => loop.data?.current.usage.by_tool ?? [], [loop.data]);
  const agentRows = useMemo(() => excludeDashboardReads(usageRows), [usageRows]);
  const agentPreviousRows = useMemo(() => excludeDashboardReads(loop.data?.previous.usage.by_tool ?? []), [loop.data]);
  const failures = useMemo(() => failuresByToolOutcome(agentRows), [agentRows]);

  return (
    <div className="flex max-w-page flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Insights</h1>
          <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
            How your lore is learned, recalled, promoted and pruned — and when it moves.
          </p>
        </div>
        <RangePicker value={range} onChange={commitRange} presets={PRESETS} nowIso={nowIso} label="Insights time range" />
      </div>

      {loop.isLoading ? (
        <Skeleton className="h-40" />
      ) : loop.isError || !stages ? (
        <Notice>{LOAD_ERROR}</Notice>
      ) : (
        <LoopStageStrip stages={stages} pulse={pulse} unit={loop.data!.unit} rangeCaption={caption} timeZone={timeZone} />
      )}

      <Section
        icon={Activity}
        title="Pulse"
        description={`Lessons written, records an agent chose on purpose, and records that rode along in a list or search — per ${loop.data?.unit ?? 'bucket'}, in ${caption}. Each row has its own scale.`}
      >
        {loop.isLoading ? (
          <Skeleton />
        ) : loop.isError ? (
          <Notice>{LOAD_ERROR}</Notice>
        ) : (
          <Card>
            <PulseTimeline buckets={pulse} unit={loop.data!.unit} timeZone={timeZone} capped={loop.data!.capped} />
          </Card>
        )}
      </Section>

      <Section
        icon={Workflow}
        title="Recall flow"
        description="Which surface asked for lore, through which read tool, from which kind of scope. Your own dashboard browsing is included — showing who reads is this chart's job."
      >
        {loop.isLoading ? <Skeleton /> : loop.isError ? <Notice>{LOAD_ERROR}</Notice> : <RecallFlowChart rows={usageRows} rangeCaption={caption} />}
      </Section>

      <Section
        icon={PlayCircle}
        title="Runs"
        description={`When sessions, CI jobs and PR automations start work with your lore, and the shape of each run, in ${caption}. Only calls that carry a run id are placed here.`}
      >
        {runs.isLoading ? (
          <Skeleton />
        ) : runs.isError ? (
          <Notice>Failed to load runs. Please refresh the page to try again.</Notice>
        ) : (runs.data?.runs.length ?? 0) === 0 ? (
          <Notice>No runs recorded in {caption}.</Notice>
        ) : (
          <Card>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <RunsRhythm runs={runs.data!.runs} timeZone={timeZone} />
              <RunsSwimlanes runs={runs.data!.runs} window={window} timeZone={timeZone} />
            </div>
            {runs.data!.truncated && (
              <p className="mt-3 text-xs text-[var(--color-content-tertiary)]">
                Showing the first {runs.data!.runs.length.toLocaleString('en-US')} runs ({MAX_RUN_PAGES} pages) — pick a
                shorter range to see them all.
              </p>
            )}
          </Card>
        )}
        <Card>
          <RunsList />
        </Card>
      </Section>

      <Section
        id="earning-its-place"
        icon={Grid2x2}
        title="Is this lore earning its place?"
        description="Every lesson placed by how often it was DELIVERED against how often an agent deliberately CHOSE it. Pick a quadrant to see its lessons and hand them to lorekit-groom. Account-wide, all time."
      >
        <LoreCostHeadline />
        <Card>
          <LoreUtilityGrid />
        </Card>
      </Section>

      <Section
        icon={Layers}
        title="Where it is read"
        description={`Scopes ranked by memory records read in ${caption} — including the unattributed bucket. Pick a scope to open it in the Explorer.`}
      >
        <Card>
          <ScopeConsumption since={window.from} until={window.to} />
        </Card>
      </Section>

      <Section
        icon={Stethoscope}
        title="Operational health"
        description={`Is it basically fine: failures by outcome, mean latency per tool, and scopes asked for but coming back empty — in ${caption}, excluding your own dashboard browsing.`}
      >
        {loop.isLoading ? (
          <Skeleton />
        ) : loop.isError ? (
          <Notice>{LOAD_ERROR}</Notice>
        ) : (
          <>
            <HealthSummary rows={agentRows} previousRows={agentPreviousRows} failures={failures} rangeCaption={caption} />
            {agentRows.length > 0 && <UsageHealth rows={agentRows} />}
          </>
        )}
      </Section>
    </div>
  );
}
