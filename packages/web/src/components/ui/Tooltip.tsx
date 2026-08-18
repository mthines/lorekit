'use client';

/**
 * Tooltip — lightweight accessible tooltip for icon triggers.
 *
 * Renders children as the trigger (typically an icon button or an `<Info>`
 * icon) and shows `content` above (default) or below on hover (desktop) or
 * tap (mobile). A second tap dismisses. Clicking outside also dismisses.
 *
 * Semantics: the tooltip panel is `role="tooltip"`, the trigger carries
 * `aria-describedby` pointing at it, and the panel is `aria-hidden` when not
 * visible. This matches the ARIA tooltip pattern and lets screen readers read
 * the description without requiring a hover interaction.
 *
 * Positioning: `top` (default) places the panel above the trigger; `bottom`
 * places it below; `align` (`center` default, `left`, `right`) sets the
 * horizontal anchor. The panel is PORTALED to `document.body` and positioned
 * with `position: fixed` against the trigger's measured rect, so it can never be
 * clipped by an ancestor's `overflow: hidden` (the collapsible stat cards and
 * their reveal regions have exactly that) — the failure the inline `absolute`
 * panel had. The computed position is then clamped to the viewport so the panel
 * cannot run off a screen edge either.
 *
 * Motion: the panel fades in/out with a short CSS transition, respecting
 * `prefers-reduced-motion` via a Tailwind utility.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** A trigger's viewport rect — the fields {@link computeTooltipPosition} reads. */
export interface TooltipTriggerRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Where the portaled panel sits, in viewport (`fixed`) coordinates.
 *
 * Pure so it is unit-testable without a DOM: it takes the measured trigger and
 * panel sizes and returns a clamped `{top,left}`. `side` picks above/below,
 * `align` picks the horizontal anchor, and both axes are clamped 8px inside the
 * viewport so the panel can never run off an edge — the guarantee the inline
 * `absolute` panel could not make once an `overflow:hidden` ancestor or a screen
 * edge got in the way.
 */
export function computeTooltipPosition(
  trigger: TooltipTriggerRect,
  panel: { width: number; height: number },
  side: 'top' | 'bottom',
  align: 'left' | 'center' | 'right',
  gap: number,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const left =
    align === 'left'
      ? trigger.left
      : align === 'right'
        ? trigger.right - panel.width
        : trigger.left + trigger.width / 2 - panel.width / 2;
  const top = side === 'top' ? trigger.top - gap - panel.height : trigger.bottom + gap;
  return {
    top: Math.max(8, Math.min(top, viewport.height - panel.height - 8)),
    left: Math.max(8, Math.min(left, viewport.width - panel.width - 8)),
  };
}

export interface TooltipProps {
  /** The tooltip text shown on hover / tap. */
  content: string;
  /** Trigger element — typically an icon. */
  children: React.ReactNode;
  /** Panel placement relative to the trigger. @default 'top' */
  side?: 'top' | 'bottom';
  /** Horizontal alignment of the panel relative to the trigger. @default 'center' */
  align?: 'left' | 'center' | 'right';
  /** Extra classes on the outer wrapper. */
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className = '',
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const tooltipId = `tooltip-${id.replace(/:/g, '')}`;

  // Portals need `document`, which is absent during SSR — mount only after the
  // first client render so the server and client trees match.
  useEffect(() => setMounted(true), []);

  // Position the portaled panel against the trigger's live rect, then clamp it
  // to the viewport. Runs while visible (measurement needs the panel laid out;
  // `opacity-0` still reports a rect) so the panel is placed before it fades in
  // — it stays `opacity-0` until `pos` is set, so the one-frame delay never
  // shows an unpositioned flash. `useEffect`, not layout, to stay quiet under
  // SSR (this is a client component that still server-renders).
  const GAP = 6;
  useEffect(() => {
    if (!visible || !triggerRef.current || !panelRef.current) return;
    const t = triggerRef.current.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    setPos(
      computeTooltipPosition(t, { width: p.width, height: p.height }, side, align, GAP, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [visible, side, align, content]);

  // Dismiss when the user clicks/taps outside the wrapper.
  const onOutsideDown = useCallback((e: PointerEvent) => {
    if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
      setVisible(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('pointerdown', onOutsideDown);
    return () => document.removeEventListener('pointerdown', onOutsideDown);
  }, [onOutsideDown]);

  // Dismiss on Escape from anywhere.
  useEffect(() => {
    if (!visible) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setVisible(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  // The panel is portaled to <body>, so it is positioned via `fixed` + the
  // measured `pos` rather than Tailwind edge utilities. Hidden until `pos` is
  // known so it never flashes at the top-left corner before it is placed.
  const panel = (
    <span
      ref={panelRef}
      id={tooltipId}
      role="tooltip"
      aria-hidden={!visible}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
      className={[
        'pointer-events-none fixed z-50 w-max max-w-[16rem] rounded-lg border border-[var(--color-border)]',
        'bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-[11px] leading-snug',
        'text-[var(--color-content-secondary)] shadow-md',
        'transition-opacity duration-150 motion-reduce:transition-none',
        visible && pos ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
      {content}
    </span>
  );

  return (
    <span
      ref={wrapperRef}
      className={`relative inline-flex items-center ${className}`}
      // Show on mouse-enter; hide on mouse-leave for pointer devices.
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      // Toggle on tap for touch devices.
      onClick={() => setVisible((v) => !v)}
    >
      {/* Trigger — add aria-describedby so screen readers announce the tooltip. */}
      <span ref={triggerRef} aria-describedby={visible ? tooltipId : undefined}>
        {children}
      </span>

      {mounted && createPortal(panel, document.body)}
    </span>
  );
}
