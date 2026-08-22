'use client';

/**
 * AnchoredTooltip — a portaled readout positioned against an arbitrary element.
 *
 * ## The bug it exists to fix
 *
 * A chart's per-bucket readout was an `absolute` panel inside the bar it
 * described. In the Lore Explorer that bar lives in `CollapsibleStatCard`, whose
 * reveal region is `overflow: hidden` — that is what lets the card animate its
 * own height — so the readout was clipped at the card's edge exactly when the
 * chart was interesting. Raising a `z-index` cannot fix it: `overflow` clips
 * descendants regardless of stacking. The only fix is to stop being a descendant.
 *
 * ## Why not {@link Tooltip}
 *
 * `Tooltip` already solves this, and this component reuses its pure positioner
 * verbatim rather than growing a second one. What it cannot reuse is `Tooltip`'s
 * SHAPE: `Tooltip` wraps its own trigger and owns its own hover state, so it is
 * one component (and one portal, and one set of listeners) per trigger. A
 * contribution heatmap has up to 364 triggers and a sparkbar up to 90, all
 * sharing a single "which one is active" state that the chart already tracks. So
 * this is the content-only half — the caller says WHICH element is anchoring and
 * WHEN, and one instance serves every bucket.
 *
 * `Tooltip` remains the right choice for a lone icon trigger; this is the right
 * choice for many triggers sharing one selection.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { computeTooltipPosition } from '@/components/ui/Tooltip';

export interface AnchoredTooltipProps {
  /**
   * The element the panel points at, or `null` for "nothing active".
   *
   * An ELEMENT rather than a rect, because the anchor moves: a fixed panel is
   * positioned in viewport coordinates, so any scroll of any ancestor invalidates
   * a rect that was measured once. Holding the element lets this re-measure.
   */
  anchor: Element | null;
  /** Whether the panel is shown. Separate from {@link anchor} so a caller can keep
   *  the anchor while closing (e.g. an Escape press) without a flicker. */
  open: boolean;
  /** Asks the caller to close — Escape, or a pointer-down outside the anchor. */
  onDismiss?: () => void;
  /** Preferred side. Auto-flips when there is no room; see `computeTooltipPosition`. */
  side?: 'top' | 'bottom';
  /** Horizontal anchoring. Clamped to the viewport regardless. */
  align?: 'left' | 'center' | 'right';
  /** The readout. Kept as children so a caller can mark up its own numbers. */
  children: React.ReactNode;
  /** Element id, so an anchor can point `aria-describedby` at the panel. */
  id?: string;
}

/** Matches `Tooltip`'s gap, so the two read as one system. */
const GAP = 6;

export function AnchoredTooltip({
  anchor,
  open,
  onDismiss,
  side = 'top',
  align = 'center',
  children,
  id,
}: AnchoredTooltipProps) {
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Portals need `document`, absent during SSR — mount only after the first
  // client render so the server and client trees match.
  useEffect(() => setMounted(true), []);

  const visible = open && anchor !== null;

  const reposition = useCallback(() => {
    if (!anchor || !panelRef.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    setPos(
      computeTooltipPosition(a, { width: p.width, height: p.height }, side, align, GAP, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [anchor, side, align]);

  // Measure once the panel is in the tree AND visible. `mounted` is a real
  // dependency, not a convenience: the panel is only portaled once mounted, so
  // before that `panelRef.current` is null and the effect would measure nothing
  // and never re-run.
  //
  // `useLayoutEffect`, because this runs BEFORE paint. Opening is safe either way
  // — `pos` is null then, and the panel is held at `opacity-0` until it is placed
  // — but MOVING is not: hovering from one bar to the next swaps `anchor` while
  // the panel stays visible at `opacity-100`, so a post-paint effect shows the new
  // content at the OLD bucket's coordinates for a frame. Across a 30-bar sparkbar
  // that is a readout which visibly trails the cursor. Measuring in the layout
  // phase commits the position in the same frame as the content it belongs to.
  // (Bare, not an isomorphic wrapper: `Combobox`, `FilterMenu`, `FilterPill` and
  // `FadeScroller` all measure this way.)
  useLayoutEffect(() => {
    if (mounted && visible) reposition();
  }, [mounted, visible, reposition, children]);

  // A `fixed` panel does not travel with its anchor, so a scroll leaves it
  // hanging over unrelated content. Re-measure while open — `capture: true` so
  // scrolls inside a non-window scroller (the Explorer's own panes) are heard,
  // `passive` so this never blocks the scroll it follows. Only subscribed while
  // visible, so a closed tooltip costs nothing.
  useEffect(() => {
    if (!visible) return undefined;
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true });
      window.removeEventListener('resize', reposition);
    };
  }, [visible, reposition]);

  // Escape dismisses. Charts here toggle a readout on TAP as well as hover, so on
  // a touch device (and for a keyboard user who tabbed onto a bucket) there has to
  // be a way out that is not "find the element and interact with it again".
  useEffect(() => {
    if (!visible || !onDismiss) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss?.();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, onDismiss]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="tooltip"
      aria-hidden={!visible}
      // Positioned in viewport coordinates because it is a child of <body> now,
      // not of the chart. Hidden until `pos` is known so it never flashes at the
      // top-left corner before it is placed.
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
      className={[
        'pointer-events-none fixed z-50 w-max whitespace-nowrap rounded-md border',
        'border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5',
        'text-[10px] leading-snug shadow-md',
        'transition-opacity duration-150 motion-reduce:transition-none',
        visible && pos ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
      {children}
    </div>,
    document.body,
  );
}
