'use client';

/**
 * TimelineInstrument — write volume per day, where a drag is a date filter.
 *
 * ## Why it earns a place beside the heatmap
 *
 * The Activity panel's contribution heatmap already shows when memories were
 * written, and clicking a cell already filters. What it cannot do is select a
 * SPAN in one gesture: its two-click anchor-then-extend is a chord you have to
 * know, and on a calendar grid a range that crosses a week boundary is not a
 * contiguous shape. A linear track makes "these three weeks" one drag, which is
 * how people actually narrow a time window.
 *
 * Both write the same `?range=` value in the same `YYYY-MM-DD` form, so the two
 * controls stay interchangeable rather than becoming two sources of truth.
 *
 * ## Pointer events, not mouse events
 *
 * The whole gesture is Pointer Events, so touch, pen and mouse take one code
 * path. Three details are load-bearing on a phone:
 *
 *  - `setPointerCapture` on down, so a drag that leaves the element keeps
 *    updating instead of stopping at the edge — and `dayIndexAt` clamps, so
 *    leaving the track selects the nearest edge rather than an out-of-range day.
 *  - `touch-action: none` on the track, so the browser does not claim the drag
 *    for a page scroll before the second pointermove arrives. Without it, a
 *    horizontal drag on a phone scrolls the page and the brush never starts.
 *  - A tap (down and up with no movement) is a single-day selection, not a
 *    dropped gesture — the same thing a heatmap cell click means.
 *
 * ## Keyboard
 *
 * The track is not the only way in: each bar is a real `<button>`, so Tab
 * reaches a day and Enter selects it. A range needs the drag; a day does not.
 *
 * The bars answer to the keyboard ONLY — every pointer gesture, tap included,
 * is the track's. Letting both respond to a pointer meant a drag released over
 * a bar fired that bar's click too, replacing the range with a single day.
 */

import { useCallback, useRef, useState } from 'react';
import { brushRange, dayIndexAt } from '@/lib/explorer-instruments';

export interface TimelineDay {
  /** `YYYY-MM-DD`. */
  date: string;
  count: number;
}

interface TimelineInstrumentProps {
  /** Per-day write counts, ascending. Sparse input is fine — gaps render as zero. */
  days: readonly TimelineDay[];
  /** The currently selected window, inclusive, or null. */
  selected: { from: string; to: string } | null;
  onSelectRange: (range: { from: string; to: string }) => void;
  onClear: () => void;
}

export function TimelineInstrument({
  days,
  selected,
  onSelectRange,
  onClear,
}: TimelineInstrumentProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  // The in-progress gesture. Null when not dragging. Kept in state (not a ref)
  // because the preview highlight has to re-render as it changes.
  const [drag, setDrag] = useState<{ anchor: number; head: number } | null>(null);

  const max = days.reduce((m, d) => Math.max(m, d.count), 0);

  const indexAt = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return dayIndexAt(clientX - rect.left, rect.width, days.length);
    },
    [days.length],
  );

  const commit = useCallback(
    (a: number, b: number) => {
      const from = days[Math.min(a, b)]?.date;
      const to = days[Math.max(a, b)]?.date;
      if (!from || !to) return;
      onSelectRange(brushRange(from, to));
    },
    [days, onSelectRange],
  );

  // The span being previewed mid-drag, or the committed selection when idle.
  const preview = drag
    ? { lo: Math.min(drag.anchor, drag.head), hi: Math.max(drag.anchor, drag.head) }
    : null;

  const isHighlighted = (i: number, date: string) => {
    if (preview) return i >= preview.lo && i <= preview.hi;
    if (!selected) return false;
    return date >= selected.from && date <= selected.to;
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={trackRef}
        // `touch-action: none` is what lets a horizontal drag be a brush instead
        // of a page scroll on a phone — see the docblock.
        className="relative flex h-[132px] w-full touch-none items-end gap-px overflow-hidden rounded-lg bg-[var(--color-bg)] px-1 py-1"
        onPointerDown={(e) => {
          // Primary pointer only: a two-finger gesture or a right-click is not a
          // brush, and treating it as one strands a drag nobody can finish.
          if (!e.isPrimary || e.button !== 0) return;
          // Capture is an ENHANCEMENT — it keeps a drag alive past the element's
          // edge — so a browser that refuses it must not take the gesture with
          // it. Chromium throws here for a pointer it does not consider active.
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // No capture: the drag still works inside the track, and
            // `dayIndexAt` clamps whatever coordinates do arrive.
          }
          const i = indexAt(e.clientX);
          setDrag({ anchor: i, head: i });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const i = indexAt(e.clientX);
          if (i !== drag.head) setDrag({ ...drag, head: i });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          // COMMIT FIRST. `releasePointerCapture` throws in Chromium when the
          // pointer is not the captured one — which happens whenever the
          // capture above was refused — and an exception here would abandon the
          // brush the reader just drew. Releasing a capture that may not exist
          // is cleanup; delivering the selection is the feature.
          commit(drag.anchor, drag.head);
          setDrag(null);
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // Nothing to release. Capture is dropped implicitly on pointerup.
          }
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {days.map((d, i) => {
          const on = isHighlighted(i, d.date);
          // Always leave a hairline so an empty day is still a tappable target
          // and the axis reads as continuous.
          const height = max > 0 ? Math.max(2, Math.round((d.count / max) * 112)) : 2;
          return (
            <button
              key={d.date}
              type="button"
              // The bars carry the KEYBOARD path only; the track carries every
              // pointer gesture, tap included (a tap is a drag whose anchor and
              // head agree).
              //
              // `detail === 0` is what separates the two: a click synthesised by
              // Enter/Space on a button reports zero, a pointer-driven click
              // reports the click count. Without this test, releasing a DRAG on
              // top of a bar also fired that bar's click, and the single-day
              // selection landed on top of the range the reader had just drawn —
              // so a brush that ended over a bar silently collapsed to one day.
              onClick={(e) => {
                if (e.detail !== 0) return;
                onSelectRange({ from: d.date, to: d.date });
              }}
              aria-label={`${d.date}: ${d.count} ${d.count === 1 ? 'memory' : 'memories'} written`}
              aria-pressed={on}
              title={`${d.date} · ${d.count}`}
              className="group relative flex h-full min-w-[3px] flex-1 cursor-pointer items-end focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            >
              <span
                aria-hidden
                className={[
                  'block w-full rounded-t-[2px] transition-colors duration-150',
                  on
                    ? 'bg-[var(--color-scope-repo)]'
                    : 'bg-[var(--color-bg-elevated)] group-hover:bg-[var(--color-border)]',
                ].join(' ')}
                style={{ height: `${height}px` }}
              />
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-[var(--color-content-tertiary)]">
        <span>{days[0]?.date ?? ''}</span>
        <span className="text-center">
          {selected
            ? `${selected.from} → ${selected.to}`
            : 'Drag across the chart to filter by date'}
        </span>
        <span className="flex items-center gap-2">
          <span>{days[days.length - 1]?.date ?? ''}</span>
          {selected && (
            <button
              type="button"
              onClick={onClear}
              className="min-h-6 rounded px-1 underline underline-offset-2 hover:text-[var(--color-content-primary)]"
            >
              Clear
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
