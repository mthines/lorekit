'use client';

/**
 * Sparkbar
 *
 * A compact, interactive bar chart for embedding in a stat card. Bars (not a
 * line) because the series is sparse counts — a line chart of mostly-zero data
 * collapses to a flat line with a single spike, which reads as broken. Bars show
 * each bucket honestly, zeros included.
 *
 * Interactivity (per /animations interaction catalog): each column is a
 * full-height hit target. Desktop hovers reveal the readout; touch taps toggle it
 * (and persist, since there is no hover on mobile) — tapping outside dismisses.
 *
 * ## Keyboard: ONE stop for the chart, arrows for the buckets
 *
 * The chart is a single tab stop that then walks its buckets with the arrow keys
 * (`Home`/`End` for the ends, `Escape` to clear). The alternative — a focusable
 * element per column — would put up to 90 tab stops between a reader and the next
 * control, and it would also mean focusable content INSIDE `role="img"`, which is
 * a leaf role: its subtree is presentational, so those stops would be reachable
 * but unannounced. One stop keeps the summary role honest and still exposes every
 * value without a pointer.
 *
 * ## The readout is PORTALED
 *
 * It used to be an `absolute bottom-full` panel inside the column. That works
 * until an ancestor clips: in the Lore Explorer this chart lives in
 * `CollapsibleStatCard`, whose reveal region is `overflow: hidden` so the card can
 * animate its own height — and the readout was cut off at the card's edge, which
 * is the state a reader actually met it in. `overflow` clips descendants whatever
 * their `z-index`, so the only fix is to stop being a descendant. One
 * {@link AnchoredTooltip} serves the whole chart, anchored to whichever column is
 * active — one portal, not one per bar.
 *
 * Motion: bars grow from the baseline via `scaleY` (GPU-composited, origin
 * bottom), staggered. Disabled under prefers-reduced-motion.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

import { AnchoredTooltip } from '@/components/ui/AnchoredTooltip';

export interface SparkPoint {
  /** Bucket label, e.g. an ISO week "2026-W30". */
  label: string;
  value: number;
}

interface SparkbarProps {
  points: SparkPoint[];
  /** Noun shown after the value in the readout, e.g. "memories". */
  unit?: string;
  className?: string;
  ariaLabel?: string;
}

/** "2026-W30" → "W30"; passes other labels through unchanged. */
function shortLabel(label: string): string {
  const i = label.indexOf('-W');
  return i >= 0 ? `W${label.slice(i + 2)}` : label;
}

/**
 * Where an arrow key moves the active bucket.
 *
 * Pure and total: `null` (nothing active) enters at the LAST bucket, because the
 * most recent bucket is the one the chart already emphasises and the one a reader
 * arriving by keyboard is most likely to want. Clamped rather than wrapping — a
 * bar chart is a line, not a ring, and silently jumping from the newest bucket to
 * the oldest reads as a glitch.
 */
export function nextIndex(current: number | null, key: string, count: number): number | null {
  const last = count - 1;
  switch (key) {
    case 'ArrowRight':
      return current === null ? last : Math.min(current + 1, last);
    case 'ArrowLeft':
      return current === null ? last : Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

export function Sparkbar({ points, unit = '', className = '', ariaLabel }: SparkbarProps) {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // The column elements, so the portaled readout can be anchored to one of them.
  // A rect would go stale on the next scroll; the element does not.
  const columnRefs = useRef<(HTMLElement | null)[]>([]);
  const id = useId();
  const readoutId = `sparkbar-readout-${id.replace(/:/g, '')}`;

  const dismiss = useCallback(() => setActive(null), []);

  // Dismiss the (tap-locked) readout when interacting outside the chart. The
  // portaled panel is `pointer-events-none` and lives under <body>, so it can
  // never be the target here.
  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setActive(null);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  if (points.length === 0) return <div className={className} aria-hidden />;

  const max = Math.max(...points.map((p) => p.value), 1);
  const activePoint = active === null ? null : points[active];

  return (
    <div
      ref={ref}
      className={`relative flex items-end gap-[2px] rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${className}`}
      role="img"
      aria-label={ariaLabel}
      aria-describedby={activePoint ? readoutId : undefined}
      // One stop for the whole chart — see the docblock.
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setActive(null);
          return;
        }
        const next = nextIndex(active, e.key, points.length);
        if (next === null) return;
        // Arrow keys inside a chart must not also scroll the page.
        e.preventDefault();
        setActive(next);
      }}
      onBlur={() => setActive(null)}
    >
      {points.map((p, i) => {
        // Non-zero bars get a floor height so a single write is still visible.
        const pct = p.value > 0 ? Math.max((p.value / max) * 100, 12) : 0;
        const isLast = i === points.length - 1;
        const isActive = active === i;
        const emphasised = isLast || isActive;

        return (
          <div
            key={`${p.label}-${i}`}
            ref={(el) => {
              columnRefs.current[i] = el;
            }}
            className="group relative flex h-full flex-1 items-end"
            onPointerEnter={(e) => {
              if (e.pointerType !== 'touch') setActive(i);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== 'touch') setActive((a) => (a === i ? null : a));
            }}
            onClick={() => setActive((a) => (a === i ? null : i))}
          >
            {/* Zero buckets show a faint baseline tick so the axis reads as continuous. */}
            {p.value === 0 && (
              <span
                className="absolute bottom-0 left-0 h-px w-full bg-[var(--color-border)]"
                aria-hidden
              />
            )}

            <motion.div
              className="w-full rounded-[1px] bg-[var(--color-accent)] transition-opacity duration-150"
              style={{
                height: `${pct}%`,
                transformOrigin: 'bottom',
                opacity: emphasised ? 1 : 0.35,
              }}
              initial={reduceMotion ? false : { scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ delay: i * 0.02, duration: 0.3, ease: 'easeOut' }}
            />
          </div>
        );
      })}

      {/* ONE readout for the whole chart, portaled out of the clipping card. */}
      <AnchoredTooltip
        id={readoutId}
        anchor={active === null ? null : (columnRefs.current[active] ?? null)}
        open={activePoint !== null}
        onDismiss={dismiss}
        side="top"
      >
        {activePoint && (
          <>
            <span className="font-mono text-[var(--color-content-tertiary)]">
              {shortLabel(activePoint.label)}
            </span>{' '}
            <span className="font-semibold tabular-nums text-[var(--color-content-primary)]">
              {activePoint.value}
            </span>
            {unit && <span className="text-[var(--color-content-tertiary)]"> {unit}</span>}
          </>
        )}
      </AnchoredTooltip>
    </div>
  );
}
