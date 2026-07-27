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
 * places it below. Edge-clipping is avoided by `align` (`center` default,
 * `left`, `right`).
 *
 * Motion: the panel fades in/out with a short CSS transition, respecting
 * `prefers-reduced-motion` via a Tailwind utility.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

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
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const tooltipId = `tooltip-${id.replace(/:/g, '')}`;

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

  const panelPosition =
    side === 'top'
      ? 'bottom-full mb-1.5'
      : 'top-full mt-1.5';

  const panelAlign =
    align === 'left'
      ? 'left-0'
      : align === 'right'
        ? 'right-0'
        : 'left-1/2 -translate-x-1/2';

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
      <span aria-describedby={visible ? tooltipId : undefined}>
        {children}
      </span>

      {/* Tooltip panel */}
      <span
        id={tooltipId}
        role="tooltip"
        aria-hidden={!visible}
        className={[
          'pointer-events-none absolute z-30 w-max max-w-[14rem] rounded-lg border border-[var(--color-border)]',
          'bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-[11px] leading-snug',
          'text-[var(--color-content-secondary)] shadow-md',
          'transition-opacity duration-150 motion-reduce:transition-none',
          panelPosition,
          panelAlign,
          visible ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        {content}
      </span>
    </span>
  );
}
