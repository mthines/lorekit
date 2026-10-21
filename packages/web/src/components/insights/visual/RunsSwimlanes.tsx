'use client';

/**
 * RunsSwimlanes — every run in the window on one time axis, one lane per
 * session kind (local session, CI job, PR automation), from
 * `lib/runs-rhythm.ts#swimlanes`.
 *
 * Bar LENGTH is the run's duration (first to last call); bar THICKNESS is how
 * many records it read, on a capped scale so one huge CI job does not flatten
 * every other run into a hairline. A run shorter than a pixel still gets a
 * visible minimum width — "it happened" is the information there.
 *
 * Same interaction contract as the other charts (`use-chart-cursor.ts`): one
 * tab stop walks every run in time order across lanes, and one portaled
 * readout names it. The audit-trail list below this chart keeps the drill-down
 * into what a run did; this view is for seeing the shape of the work.
 */

import { useId } from 'react';
import { AnchoredTooltip } from '@/components/ui/AnchoredTooltip';
import { RUN_LANE_LABEL, swimlanes } from '@/lib/runs-rhythm';
import type { AbsoluteRange } from '@/lib/time-range';
import type { UsageRun } from '@lorekit/schemas/usage';
import { useChartCursor } from './use-chart-cursor';

interface RunsSwimlanesProps {
  runs: readonly UsageRun[];
  window: AbsoluteRange;
  timeZone: string;
}

const MIN_THICKNESS = 4;
const MAX_THICKNESS = 16;

export function RunsSwimlanes({ runs, window, timeZone }: RunsSwimlanesProps) {
  const layout = swimlanes(runs, window);
  // Time order across lanes, so arrow keys move through the day, not lane by lane.
  const ordered = layout.lanes.flatMap((l) => l.runs).sort((a, b) => a.x0 - b.x0);
  const indexOf = new Map(ordered.map((r, i) => [r.run.correlation_id + r.run.first_seen, i]));
  const cursor = useChartCursor(ordered.length);
  const readoutId = `swimlane-readout-${useId().replace(/:/g, '')}`;
  const active = cursor.active === null ? null : ordered[cursor.active];

  const time = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const thickness = (records: number) =>
    layout.maxRecordsRead === 0
      ? MIN_THICKNESS
      : MIN_THICKNESS + (MAX_THICKNESS - MIN_THICKNESS) * Math.sqrt(records / layout.maxRecordsRead);

  if (ordered.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <div className="flex w-28 shrink-0 flex-col text-[11px] text-[var(--color-content-secondary)]" aria-hidden>
          {layout.lanes.map((l) => (
            <span key={l.lane} className="flex h-8 items-center">
              {RUN_LANE_LABEL[l.lane]}
              <span className="ml-1 tabular-nums text-[var(--color-content-tertiary)]">{l.runs.length}</span>
            </span>
          ))}
        </div>
        <div
          ref={cursor.rootRef}
          role="img"
          aria-label={`${ordered.length} runs across ${layout.lanes.length} kind${layout.lanes.length === 1 ? '' : 's'}. Use the arrow keys to read each run in time order.`}
          aria-describedby={active ? readoutId : undefined}
          className="relative flex min-w-0 flex-1 flex-col rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          {...cursor.rootProps}
        >
          {layout.lanes.map((l) => (
            <div key={l.lane} className="relative h-8 border-b border-[var(--color-border-subtle)] last:border-b-0">
              {l.runs.map((r) => {
                const i = indexOf.get(r.run.correlation_id + r.run.first_seen) ?? -1;
                const h = thickness(r.run.records_read);
                const isActive = cursor.active === i;
                return (
                  <div
                    key={r.run.correlation_id + r.run.first_seen}
                    ref={cursor.itemRef(i)}
                    {...cursor.itemHandlers(i)}
                    className="absolute top-1/2 -translate-y-1/2 rounded-full bg-[var(--color-accent)] transition-opacity duration-150"
                    style={{
                      left: `${r.x0 * 100}%`,
                      width: `max(6px, ${(r.x1 - r.x0) * 100}%)`,
                      height: `${h}px`,
                      opacity: cursor.active === null || isActive ? 0.85 : 0.3,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-[7.75rem] flex justify-between text-[11px] tabular-nums text-[var(--color-content-tertiary)]" aria-hidden>
        <span>{time.format(new Date(window.from))}</span>
        <span>{time.format(new Date(window.to))}</span>
      </div>

      <AnchoredTooltip id={readoutId} anchor={cursor.anchor} open={active !== null && active !== undefined} onDismiss={cursor.dismiss}>
        {active && (
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-[var(--color-content-primary)]">{active.run.correlation_id}</span>
            <span className="text-[var(--color-content-tertiary)]">
              {RUN_LANE_LABEL[active.lane]} · {time.format(new Date(active.run.first_seen))} →{' '}
              {time.format(new Date(active.run.last_seen))}
            </span>
            <span className="tabular-nums text-[var(--color-content-secondary)]">
              {active.run.records_read.toLocaleString('en-US')} records read · {active.run.write_events.toLocaleString('en-US')}{' '}
              writes · {active.run.distinct_scopes} scope{active.run.distinct_scopes === 1 ? '' : 's'}
            </span>
          </span>
        )}
      </AnchoredTooltip>
    </div>
  );
}
