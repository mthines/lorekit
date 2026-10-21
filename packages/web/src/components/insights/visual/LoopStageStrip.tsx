'use client';

/**
 * LoopStageStrip — the header of the visual Insights page: the four stages of
 * the loop LoreKit runs (Learn → Recall → Promote → Prune), each as a figure, a
 * period delta where one exists, and a sparkbar where a bucketed series exists.
 *
 * Every figure's source and its limits are in `lib/insights-loop.ts`. Two of
 * them are shown as limits rather than papered over:
 *
 *   - **Promote** is all-time (the census reads lifetime counters), so it has
 *     no delta chip and says "all-time" in place of the window caption.
 *   - **Prune** has window totals but no bucketed series yet, so it draws no
 *     bars and says so — a flat empty sparkbar would read as "nothing pruned
 *     on any day", which is a claim the data does not make.
 *
 * Read left to right, the strip answers "is the loop turning": lessons are
 * being learned, recalled, promoted and pruned — or one stage has stalled.
 */

import { ArrowRight, BookOpenCheck, Brain, Scissors, TrendingUp } from 'lucide-react';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { TrendChip } from '@/components/dashboard/StatCard';
import { Sparkbar, type SparkPoint } from '@/components/dashboard/Sparkbar';
import { chosenShare, type LoopStages, type PulseBucket } from '@/lib/insights-loop';
import { formatShare } from '@/lib/lore-cost';
import type { BucketUnit } from '@/lib/time-range';
import { formatBucketLabel } from './format';

interface LoopStageStripProps {
  stages: LoopStages;
  /** The census request failed — Promote says so instead of "loading" forever. */
  censusFailed?: boolean;
  pulse: readonly PulseBucket[];
  unit: BucketUnit;
  /** e.g. "the last 7 days". */
  rangeCaption: string;
  timeZone: string;
}

function Stage({
  icon: Icon,
  name,
  verb,
  figure,
  unitLabel,
  changePct,
  caption,
  children,
}: {
  icon: typeof Brain;
  name: string;
  verb: string;
  figure: number | null;
  unitLabel: string;
  changePct?: number | null;
  caption: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-content-tertiary)]">
          <Icon className="size-3.5" aria-hidden />
          {name}
        </p>
        {changePct !== undefined && changePct !== null && (
          // Neutral: more learning, recall or pruning is not good or bad on its own.
          <TrendChip
            changePct={changePct}
            tone="neutral"
            title="Vs. the immediately preceding period of equal length"
          />
        )}
      </div>
      <p className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
          {figure === null ? '—' : <AnimatedNumber value={figure} />}
        </span>
        <span className="text-xs text-[var(--color-content-secondary)]">{unitLabel}</span>
      </p>
      <p className="text-xs text-[var(--color-content-tertiary)]">
        {verb} · {caption}
      </p>
      <div className="mt-auto">{children}</div>
    </li>
  );
}

export function LoopStageStrip({ stages, censusFailed = false, pulse, unit, rangeCaption, timeZone }: LoopStageStripProps) {
  const label = (start: string) => formatBucketLabel(start, unit, timeZone);
  const writePoints: SparkPoint[] = pulse.map((b) => ({ label: label(b.start), value: b.written }));
  const readPoints: SparkPoint[] = pulse.map((b) => ({ label: label(b.start), value: b.chosen + b.bulk }));
  const share = formatShare(chosenShare(stages));
  // Learn and Recall come from a series that hit the row cap: say they are lower bounds.
  const incomplete = stages.seriesIncomplete ? (
    <p className="mb-1 text-[11px] text-[var(--color-warning)]">At least this many — the series hit the 1,000-row cap.</p>
  ) : null;
  const promoteVerb = stages.promote
    ? `${stages.promote.specialist} specialists could reach further`
    : censusFailed
      ? 'Census unavailable — refresh to retry'
      : 'Loading census';

  return (
    <section aria-label="The learning loop">
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stage
          icon={Brain}
          name="Learn"
          verb="Lessons written"
          figure={stages.learn.created}
          unitLabel="new lessons"
          changePct={stages.learn.changePct}
          caption={rangeCaption}
        >
          {incomplete}
          <Sparkbar points={writePoints} unit="new lessons" className="h-10" ariaLabel={`New lessons per ${unit}`} />
        </Stage>

        <Stage
          icon={BookOpenCheck}
          name="Recall"
          verb={share === null ? 'Records read' : `${share} chosen on purpose`}
          figure={stages.recall.records}
          unitLabel="records read"
          changePct={stages.recall.changePct}
          caption={rangeCaption}
        >
          {incomplete}
          <Sparkbar points={readPoints} unit="records" className="h-10" ariaLabel={`Records read per ${unit}`} />
        </Stage>

        <Stage
          icon={TrendingUp}
          name="Promote"
          verb={promoteVerb}
          figure={stages.promote?.loadBearing ?? null}
          unitLabel="load-bearing"
          caption="all-time"
        >
          <a
            href="#earning-its-place"
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] hover:underline"
          >
            Candidates for a permanent rule
            <ArrowRight className="size-3" aria-hidden />
          </a>
        </Stage>

        <Stage
          icon={Scissors}
          name="Prune"
          verb={`${stages.prune.archived} archived · ${stages.prune.expired} expired`}
          figure={stages.prune.archived + stages.prune.expired}
          unitLabel="pruned"
          changePct={stages.prune.changePct}
          caption={rangeCaption}
        >
          <p className="text-[11px] text-[var(--color-content-tertiary)]">
            Window total only — archives and expiries are not recorded per day yet.
          </p>
        </Stage>
      </ol>
    </section>
  );
}
