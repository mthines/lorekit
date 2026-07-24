'use client';

/**
 * Sparkbar
 *
 * A compact, interactive weekly bar chart for embedding in a stat card. Bars
 * (not a line) because the series is sparse weekly counts — a line chart of
 * mostly-zero data collapses to a flat line with a single spike, which reads as
 * broken. Bars show each week honestly, zeros included.
 *
 * Interactivity (per /animations interaction catalog): each column is a
 * full-height hit target. Desktop hovers reveal a tooltip; touch taps toggle it
 * (and persist, since there is no hover on mobile) — tapping outside dismisses.
 *
 * Motion: bars grow from the baseline via `scaleY` (GPU-composited, origin
 * bottom), staggered. Disabled under prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

export interface SparkPoint {
  /** Bucket label, e.g. an ISO week "2026-W30". */
  label: string;
  value: number;
}

interface SparkbarProps {
  points: SparkPoint[];
  /** Noun shown after the value in the tooltip, e.g. "lessons". */
  unit?: string;
  className?: string;
  ariaLabel?: string;
}

/** "2026-W30" → "W30"; passes other labels through unchanged. */
function shortLabel(label: string): string {
  const i = label.indexOf('-W');
  return i >= 0 ? `W${label.slice(i + 2)}` : label;
}

export function Sparkbar({ points, unit = '', className = '', ariaLabel }: SparkbarProps) {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss the (tap-locked) tooltip when interacting outside the chart.
  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setActive(null);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  if (points.length === 0) return <div className={className} aria-hidden />;

  const max = Math.max(...points.map((p) => p.value), 1);

  return (
    <div
      ref={ref}
      className={`relative flex items-end gap-[2px] ${className}`}
      role="img"
      aria-label={ariaLabel}
    >
      {points.map((p, i) => {
        // Non-zero bars get a floor height so a single write is still visible.
        const pct = p.value > 0 ? Math.max((p.value / max) * 100, 12) : 0;
        const isLast = i === points.length - 1;
        const isActive = active === i;
        const emphasised = isLast || isActive;
        // Keep the tooltip inside the card at the edges.
        const align =
          i === 0 ? 'left-0' : i === points.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2';

        return (
          <div
            key={`${p.label}-${i}`}
            className="group relative flex h-full flex-1 items-end"
            onPointerEnter={(e) => {
              if (e.pointerType !== 'touch') setActive(i);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== 'touch') setActive((a) => (a === i ? null : a));
            }}
            onClick={() => setActive((a) => (a === i ? null : i))}
          >
            {/* Zero weeks show a faint baseline tick so the axis reads as continuous. */}
            {p.value === 0 && (
              <span className="absolute bottom-0 left-0 h-px w-full bg-[var(--color-border)]" aria-hidden />
            )}

            <motion.div
              className="w-full rounded-[1px] bg-[var(--color-accent)] transition-opacity duration-150"
              style={{ height: `${pct}%`, transformOrigin: 'bottom', opacity: emphasised ? 1 : 0.35 }}
              initial={reduceMotion ? false : { scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ delay: i * 0.02, duration: 0.3, ease: 'easeOut' }}
            />

            {isActive && (
              <div
                className={`pointer-events-none absolute bottom-full z-20 mb-1 whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] shadow-md ${align}`}
              >
                <span className="font-mono text-[var(--color-content-tertiary)]">{shortLabel(p.label)}</span>{' '}
                <span className="font-semibold tabular-nums text-[var(--color-content-primary)]">{p.value}</span>
                {unit && <span className="text-[var(--color-content-tertiary)]"> {unit}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
