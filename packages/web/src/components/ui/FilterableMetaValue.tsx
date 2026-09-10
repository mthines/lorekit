'use client';

/**
 * FilterableMetaValue — hover/focus-reveal "Filter by this" affordance for a
 * detail-panel metadata VALUE (R3, `lore-explorer-panel-nav-facets`; floating
 * presentation added by the panel's UI-polish follow-up).
 *
 * ## Why a floating panel, not an inline icon
 *
 * The first cut of this component rendered a small `IconButton` INSIDE the
 * metadata row (hover-revealed via `opacity`), matching the affordance's own
 * click target to its visual position. That has a real cost: an
 * `opacity-0` element still occupies its box in the flex row, so every
 * metadata row was permanently a few pixels wider than its content needed —
 * eating into the `truncate` budget of `dd` values that are already tight —
 * even though nothing was visibly there. "Always present" is a layout fact,
 * not just a visual one.
 *
 * This version renders NOTHING inline. The affordance is a portaled panel —
 * the same `computeTooltipPosition` math {@link Tooltip} and
 * `AnchoredTooltip` already share — anchored ABOVE the hovered/focused value,
 * mounted to `document.body` only while open. A closed row costs the metadata
 * list nothing; an open one floats a small clickable "Filter by this …" pill
 * above the value without disturbing its layout.
 *
 * ## Two independent activation paths, not one
 *
 * A floating panel breaks the usual "hover the trigger, then move onto the
 * panel to click it" flow: the panel sits a few pixels above the value, and a
 * pointer crossing that gap can leave the anchor's hover box before it lands
 * on the panel. `CLOSE_DELAY_MS` bridges that (a short grace period before
 * closing, cancelled by re-entering either the anchor OR the panel), so a
 * normal mouse move reaches the panel's button before it disappears.
 *
 * Keyboard access does NOT depend on that bridge at all: the anchor itself is
 * a `tabIndex={0}` "button" — focusing it (Tab) reveals the panel as a visual
 * confirmation, and Enter/Space activates the filter immediately, with no
 * need to Tab again into a portaled element sitting at the end of the DOM
 * (which would be a legitimate but out-of-order stop). The panel's own button
 * remains a second, mouse-convenient path to the exact same action.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ListFilter } from 'lucide-react';

import { track } from '@/lib/analytics/track';
import { computeTooltipPosition } from './Tooltip';

interface FilterableMetaValueProps {
  /** The rendered value — a chip, a link, or plain text. */
  children: ReactNode;
  /** Accessible name / floating label for the affordance, e.g. `Filter by host "reviewer"`. */
  label: string;
  onFilter: () => void;
}

/** Matches `Tooltip`/`AnchoredTooltip`'s gap, so the two read as one system. */
const GAP = 6;
/** Bridges the visual gap between the value and the floating panel above it. */
const CLOSE_DELAY_MS = 200;

export function FilterableMetaValue({ children, label, onFilter }: FilterableMetaValueProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Portals need `document`, absent during SSR — mount only after the first
  // client render so the server and client trees match.
  useEffect(() => setMounted(true), []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);
  // Never leave a pending close running past unmount (e.g. the sheet closes
  // while a row is still hovered).
  useEffect(() => () => cancelClose(), [cancelClose]);

  const reposition = useCallback(() => {
    if (!anchorRef.current || !panelRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    setPos(
      computeTooltipPosition(a, { width: p.width, height: p.height }, 'top', 'center', GAP, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, []);

  // Layout-phase measurement (not `useEffect`) so the panel is placed in the
  // same frame it becomes visible — see `AnchoredTooltip`'s identical
  // reasoning for why a post-paint measure would show one frame at (0,0).
  useLayoutEffect(() => {
    if (mounted && open) reposition();
  }, [mounted, open, reposition]);

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true });
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  const activate = useCallback(() => {
    track({ name: 'ui.button_click', buttonId: 'lesson-detail.filter-by-metadata' });
    onFilter();
    setOpen(false);
  }, [onFilter]);

  function handleAnchorKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  }

  return (
    <span
      ref={anchorRef}
      role="button"
      tabIndex={0}
      aria-label={label}
      className="inline-flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={scheduleClose}
      onKeyDown={handleAnchorKeyDown}
    >
      {children}
      {mounted &&
        createPortal(
          <div
            ref={panelRef}
            data-testid="filterable-meta-value-flyout"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
            className={[
              'fixed z-50 transition-opacity duration-150 motion-reduce:transition-none',
              open && pos ? 'opacity-100' : 'pointer-events-none opacity-0',
            ].join(' ')}
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={activate}
              className={[
                'inline-flex items-center gap-1 whitespace-nowrap rounded-md border',
                'border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-1',
                'text-[10px] leading-snug text-[var(--color-content-secondary)] shadow-md',
                'transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]',
              ].join(' ')}
            >
              <ListFilter className="size-3" aria-hidden />
              {label}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
