'use client';

/**
 * InsightsVisualPage — the visual first version of `/insights`, rendered when
 * `insights-visual` is on (see `InsightsView.tsx`). With it off the page is the
 * original `InsightsPage`, untouched.
 *
 * ## The bill leads, then the loop, then when it moves
 *
 *   0. **The cost line** (`LoreCostHeadline`) stays first, per the decision
 *      that `/insights` leads with the bill (`docs/decisions.md`): everything
 *      below it is a volume, and a volume alone reads as health.
 *   1. **The loop** — Learn → Recall → Promote → Prune as one strip
 *      (`LoopStageStrip`): is the loop turning, and where has it stalled?
 *   2. **Pulse** — written, chosen and bulk on one time axis (`PulseTimeline`).
 *   3. **Recall flow** — who asked, through which tool, from which scope type.
 *   4. **Runs** — when work starts (weekday × hour) and its shape (swimlanes),
 *      with the existing audit-trail list kept below for the drill-down.
 *   5. **Is this lore earning its place?** — the existing utility grid,
 *      unchanged. It is the one section readers interact with today (quadrant
 *      picks and copied groom prompts), so the visual page keeps it whole
 *      rather than re-drawing it.
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
 *
 * While a new range loads, the previous result stays on screen, dimmed and
 * `aria-busy`, and every grid is drawn from the window that result was fetched
 * for (`data.window`), never from the newly selected one.
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
import { loopStages, pulseBuckets, pulseTotals, rawTotals } from '@/lib/insights-loop';
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

  // Gridded from the window the rows were FETCHED for — see the module docblock.
  const pulse = useMemo(
    () => (loop.data ? pulseBuckets(loop.data.window, loop.data.unit, loop.data.current.writes, loop.data.current.reads) : []),
    [loop.data],
  );
  const stages = useMemo(() => {
    if (!loop.data) return null;
    const { current, previous, currentCapped, previousCapped } = loop.data;
    return loopStages(
      { totals: rawTotals(current.writes, current.reads), summary: current.usage.summary },
      { totals: rawTotals(previous.writes, previous.reads), summary: previous.usage.summary },
      census.data?.census ?? null,
      currentCapped || previousCapped,
    );
  }, [loop.data, census.data]);
  const updating = loop.isPlaceholderData || runs.isPlaceholderData;

  const data = loop.data;
  const runData = runs.data;
  const pulseIsEmpty = useMemo(() => {
    const t = pulseTotals(pulse);
    return t.written + t.chosen + t.bulk === 0;
  }, [pulse]);

  const usageRows = useMemo(() => loop.data?.current.usage.by_tool ?? [], [loop.data]);
  const agentRows = useMemo(() => excludeDashboardReads(usageRows), [usageRows]);
  const agentPreviousRows = useMemo(() => excludeDashboardReads(loop.data?.previous.usage.by_tool ?? []), [loop.data]);
  const failures = useMemo(() => failuresByToolOutcome(agentRows), [agentRows]);

  return (
    <div className="flex max-w-page flex-col gap-8" aria-busy={updating || undefined}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Insights</h1>
          <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
            How your lore is learned, recalled, promoted and pruned — and when it moves.
          </p>
        </div>
        <RangePicker value={range} onChange={commitRange} presets={PRESETS} nowIso={nowIso} label="Insights time range" />
      </div>

      {/* The bill leads — see the module docblock. Its own 30-day window, captioned in its sentence. */}
      <LoreCostHeadline />

      <div className={`flex flex-col gap-8 transition-opacity duration-200 ${updating ? 'opacity-60' : ''}`}>
        {loop.isLoading ? (
          <Skeleton className="h-40" />
        ) : loop.isError || !data || !stages ? (
          <Notice>{LOAD_ERROR}</Notice>
        ) : (
          <LoopStageStrip
            stages={stages}
            censusFailed={census.isError}
            pulse={pulse}
            unit={data.unit}
            rangeCaption={caption}
            timeZone={timeZone}
          />
        )}

        <Section
          icon={Activity}
          title="Pulse"
          description={`Lessons written, records an agent chose on purpose, and records that rode along in a list or search — per ${data?.unit ?? 'bucket'}, in ${caption}. Each row has its own scale.`}
        >
          {loop.isLoading ? (
            <Skeleton />
          ) : loop.isError || !data ? (
            <Notice>{LOAD_ERROR}</Notice>
          ) : pulseIsEmpty ? (
            <Notice>Nothing was written or read in {caption}.</Notice>
          ) : (
            <Card>
              <PulseTimeline buckets={pulse} rangeCaption={caption} unit={data.unit} timeZone={timeZone} capped={data.currentCapped} />
            </Card>
          )}
        </Section>

        <Section
          icon={Workflow}
          title="Recall flow"
          description={`Which surface asked for lore, through which read tool, from which kind of scope — successful calls in ${caption}. Your own dashboard browsing is included: showing who reads is this chart's job.`}
        >
          {loop.isLoading ? <Skeleton /> : loop.isError ? <Notice>{LOAD_ERROR}</Notice> : <RecallFlowChart rows={usageRows} rangeCaption={caption} />}
        </Section>

        <Section
          icon={PlayCircle}
          title="Runs"
          description={`When sessions, CI jobs and PR automations start work with your lore, and the shape of each run, in ${caption}. Only calls that carry a run id are placed. The audit-trail list below keeps its own 90-day window.`}
        >
          {runs.isLoading ? (
            <Skeleton />
          ) : runs.isError ? (
            <Notice>Failed to load runs. Please refresh the page to try again.</Notice>
          ) : !runData || runData.runs.length === 0 ? (
            <Notice>No runs recorded in {caption}.</Notice>
          ) : (
            <Card>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <RunsRhythm runs={runData.runs} timeZone={timeZone} />
                <RunsSwimlanes runs={runData.runs} window={runData.window} timeZone={timeZone} />
              </div>
              {runData.truncated && (
                <p className="mt-3 text-xs text-[var(--color-content-tertiary)]">
                  Showing the {runData.runs.length.toLocaleString('en-US')} most recent runs ({MAX_RUN_PAGES} pages), so the
                  start of the window may look emptier than it was — pick a shorter range to see them all.
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
    </div>
  );
}
