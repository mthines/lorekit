'use client';

/**
 * PulseTimeline — when memory moves: lessons written, records chosen on
 * purpose, and records delivered in bulk, as three rows on ONE shared time
 * axis with one cursor across all three.
 *
 * ## Small multiples, not a stacked or mirrored bar
 *
 * Bulk deliveries outnumber deliberate fetches by orders of magnitude, so a
 * stacked read bar would draw "chosen" as an invisible sliver, and mirroring
 * writes against reads would put two very different scales on one axis — a
 * dual axis in disguise. Three rows, each with its OWN scale and its maximum
 * printed beside it, keep every series readable and every scale stated. The
 * shared column is what lets a reader compare the three at one moment.
 *
 * Colour is never the only encoding: each row is also named and positioned.
 *
 * ## One cursor, one readout
 *
 * A column spans all three rows, so hovering (or arrowing to) a bucket shows
 * every figure for that bucket in one portaled readout — the same contract as
 * `Sparkbar` (see `use-chart-cursor.ts`).
 */

import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AnchoredTooltip } from '@/components/ui/AnchoredTooltip';
import { pulseTotals, type PulseBucket } from '@/lib/insights-loop';
import type { BucketUnit } from '@/lib/time-range';
import { formatBucketLabel, formatCompact } from './format';
import { useChartCursor } from './use-chart-cursor';

interface PulseTimelineProps {
  buckets: readonly PulseBucket[];
  unit: BucketUnit;
  timeZone: string;
  /** The series reached the row cap — newest buckets may be missing. */
  capped: boolean;
}

const ROWS = [
  { key: 'written', label: 'Written', hint: 'new lessons', color: 'bg-[var(--color-accent)]', height: 'h-12' },
  { key: 'chosen', label: 'Chosen', hint: 'records fetched on purpose', color: 'bg-[var(--color-success)]', height: 'h-12' },
  { key: 'bulk', label: 'Bulk', hint: 'records riding along in list/search', color: 'bg-[var(--color-content-tertiary)]', height: 'h-16' },
] as const;

type RowKey = (typeof ROWS)[number]['key'];

export function PulseTimeline({ buckets, unit, timeZone, capped }: PulseTimelineProps) {
  const cursor = useChartCursor(buckets.length);
  const readoutId = `pulse-readout-${useId().replace(/:/g, '')}`;
  const totals = pulseTotals(buckets);
  const max: Record<RowKey, number> = {
    written: Math.max(1, ...buckets.map((b) => b.written)),
    chosen: Math.max(1, ...buckets.map((b) => b.chosen)),
    bulk: Math.max(1, ...buckets.map((b) => b.bulk)),
  };
  const label = (b: PulseBucket) => formatBucketLabel(b.start, unit, timeZone);
  const activeBucket = cursor.active === null ? null : buckets[cursor.active];
  const tickIndexes = buckets.length > 2 ? [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1] : buckets.map((_, i) => i);

  if (buckets.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {capped && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--color-warning)]" role="status">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          This window returned the server&apos;s 1,000-row maximum, so the newest buckets may be missing. Pick a
          shorter range for a complete picture.
        </p>
      )}

      <div className="flex gap-3">
        {/* Row labels — the series are named by position, not only by colour. */}
        <div className="flex w-20 shrink-0 flex-col gap-1 text-[11px]">
          {ROWS.map((row) => (
            <div key={row.key} className={`${row.height} flex flex-col justify-end`}>
              <span className="font-medium text-[var(--color-content-secondary)]">{row.label}</span>
              <span className="tabular-nums text-[var(--color-content-tertiary)]">max {formatCompact(max[row.key])}</span>
            </div>
          ))}
        </div>

        <div
          ref={cursor.rootRef}
          role="img"
          aria-label={`Per ${unit}: ${totals.written} lessons written, ${totals.chosen} records chosen on purpose, ${totals.bulk} records delivered in bulk. Use the arrow keys to read each ${unit}.`}
          aria-describedby={activeBucket ? readoutId : undefined}
          className="flex min-w-0 flex-1 gap-[2px] rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          {...cursor.rootProps}
        >
          {buckets.map((b, i) => {
            const isActive = cursor.active === i;
            return (
              <div
                key={b.start}
                ref={cursor.itemRef(i)}
                className="flex min-w-0 flex-1 cursor-default flex-col gap-1"
                {...cursor.itemHandlers(i)}
              >
                {ROWS.map((row) => {
                  const value = b[row.key];
                  const pct = value > 0 ? Math.max((value / max[row.key]) * 100, 8) : 0;
                  return (
                    <div key={row.key} className={`relative flex ${row.height} items-end`}>
                      {value === 0 && <span className="absolute bottom-0 left-0 h-px w-full bg-[var(--color-border)]" aria-hidden />}
                      <div
                        className={`w-full rounded-[1px] ${row.color} transition-[height,opacity] duration-200`}
                        style={{ height: `${pct}%`, opacity: cursor.active === null || isActive ? 0.9 : 0.35 }}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Three ticks — first, middle, last — enough to anchor the axis without crowding it. */}
      <div className="ml-[5.75rem] flex justify-between text-[11px] tabular-nums text-[var(--color-content-tertiary)]" aria-hidden>
        {tickIndexes.map((i) => (
          <span key={i}>{buckets[i] ? label(buckets[i]) : ''}</span>
        ))}
      </div>

      <AnchoredTooltip id={readoutId} anchor={cursor.anchor} open={activeBucket !== null && activeBucket !== undefined} onDismiss={cursor.dismiss}>
        {activeBucket && (
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-[var(--color-content-tertiary)]">{label(activeBucket)}</span>
            {ROWS.map((row) => (
              <span key={row.key}>
                <span className="font-semibold tabular-nums text-[var(--color-content-primary)]">
                  {activeBucket[row.key].toLocaleString('en-US')}
                </span>{' '}
                <span className="text-[var(--color-content-tertiary)]">{row.hint}</span>
              </span>
            ))}
          </span>
        )}
      </AnchoredTooltip>
    </div>
  );
}
