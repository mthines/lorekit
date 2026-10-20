'use client';

/**
 * FilterableMetaValue — hover/focus-reveal "filter in / filter out" affordance
 * for a detail-panel metadata VALUE (R3, `lore-explorer-panel-nav-facets`;
 * floating presentation added by the panel's UI-polish follow-up; the in/out
 * pair by the filter-out follow-up).
 *
 * ## Two icons, each explained by its own tooltip
 *
 * The flyout is a compact pair of icon buttons — funnel-plus "filter in",
 * funnel-minus "filter out" — rather than a sentence-long text button. Funnels
 * rather than magnifiers: a magnifier reads as "search" or "zoom", and this
 * acts on the filter bar, whose own trigger is a filter glyph. The words moved
 * into a second-level {@link Tooltip} on each icon, so the resting flyout stays
 * small and the explanation is one hover away. A value that is
 * already filtered in or out shows that button pressed, and its tooltip says
 * how to take the filter back off (pressing it again does exactly that).
 *
 * `onFilterOut` is optional: the scope has no "not this" on the API, so its
 * flyout offers filter in alone rather than a button that could not work.
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
 * list nothing; an open one floats the icon pair above the value without
 * disturbing its layout.
 *
 * ## Two independent activation paths, not one
 *
 * A floating panel breaks the usual "hover the trigger, then move onto the
 * panel to click it" flow: the panel sits a few pixels above the value, and a
 * pointer crossing that gap can leave the anchor's hover box before it lands
 * on the panel. `CLOSE_DELAY_MS` bridges that (a short grace period before
 * closing, cancelled by re-entering either the anchor OR the panel), so a
 * normal mouse move reaches the panel's buttons before it disappears.
 *
 * Keyboard access does NOT depend on that bridge at all: the anchor itself is
 * a `tabIndex={0}` "button" — focusing it (Tab) reveals the panel as a visual
 * confirmation, Enter/Space filters in and Shift+Enter/Shift+Space filters
 * out, with no need to Tab again into a portaled element sitting at the end of
 * the DOM (which would be a legitimate but out-of-order stop). The anchor's
 * accessible name states both keys. The panel's buttons remain a second,
 * mouse-convenient path to the exact same actions.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FunnelPlus, createLucideIcon, type LucideIcon } from 'lucide-react';

import { track } from '@/lib/analytics/track';
import { filterActionLabel, filterAnchorLabel } from '@/lib/filter-from-metadata';
import type { FilterPolarity } from '@/lib/filters';
import { Tooltip, computeTooltipPosition } from './Tooltip';

interface FilterableMetaValueProps {
  /** The rendered value — a chip, a link, or plain text. */
  children: ReactNode;
  /** The value in words, used in every label and tooltip — e.g. `tag "perf"`, `host "reviewer"`. */
  subject: string;
  onFilterIn: () => void;
  /** Omit where there is no "not this" filter (the scope); the flyout then offers filter in alone. */
  onFilterOut?: () => void;
  /**
   * Whether this value is currently filtered in or out by the applied filter/
   * scope state (`metaValueFilterState`, `lib/filter-from-metadata.ts`), or
   * neither. Renders the value with the accent "applied" cue a committed
   * `FilterPill` uses when it is IN, and struck through and muted when it is
   * OUT — so the panel answers "which of this memory's attributes am I
   * filtering by" independent of hover/focus — and presses the matching
   * button. Purely a visual state: it never disables anything.
   * @default null
   */
  state?: FilterPolarity | null;
  /**
   * Whether the value itself carries the in/out cue. A caller that already
   * styles a larger container for it (a tag chip) turns this off and keeps only
   * the pressed button, rather than drawing a box inside its own box.
   * @default true
   */
  cueOnValue?: boolean;
}

/**
 * lucide ships `FunnelPlus` and `FunnelX` but no funnel-minus, and `FunnelX`
 * reads as "clear the filter" rather than "filter this out". This is
 * `FunnelPlus`'s own funnel and horizontal stroke without the vertical one, so
 * the pair matches stroke for stroke.
 */
const FunnelMinus = createLucideIcon('funnel-minus', [
  [
    'path',
    {
      d: 'M13.354 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l1.218-1.348',
      key: 'funnel',
    },
  ],
  ['path', { d: 'M16 6h6', key: 'minus' }],
]);

/** Matches `Tooltip`/`AnchoredTooltip`'s gap, so the two read as one system. */
const GAP = 6;
/** Bridges the visual gap between the value and the floating panel above it. */
const CLOSE_DELAY_MS = 200;

const ANCHOR_STATE_CLASS: Record<FilterPolarity, string> = {
  include: 'rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] px-1 py-0.5 -mx-1 -my-0.5',
  exclude:
    'rounded-md border border-dashed border-[var(--color-border)] px-1 py-0.5 -mx-1 -my-0.5 opacity-70 line-through decoration-[var(--color-content-tertiary)]',
};

export function FilterableMetaValue({
  children,
  subject,
  onFilterIn,
  onFilterOut,
  state = null,
  cueOnValue = true,
}: FilterableMetaValueProps) {
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

  const activate = useCallback(
    (polarity: FilterPolarity) => {
      const apply = polarity === 'exclude' ? onFilterOut : onFilterIn;
      if (!apply) return;
      track({
        name: 'ui.button_click',
        buttonId: polarity === 'exclude' ? 'lesson-detail.filter-out-by-metadata' : 'lesson-detail.filter-by-metadata',
      });
      apply();
      setOpen(false);
    },
    [onFilterIn, onFilterOut],
  );

  function handleAnchorKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate(event.shiftKey && onFilterOut ? 'exclude' : 'include');
  }

  return (
    <span
      ref={anchorRef}
      role="button"
      tabIndex={0}
      aria-label={filterAnchorLabel(subject, onFilterOut !== undefined)}
      aria-keyshortcuts={onFilterOut ? 'Enter Shift+Enter' : 'Enter'}
      // The applied-filter cue is a passive style on the anchor itself, not an
      // extra wrapping element — "in" is the same "border-accent/40 +
      // bg-accent-subtle" combo `FilterPill`/`FilterMenu`'s trigger use for
      // their own applied state, scaled down to a value's inline footprint;
      // "out" is struck through, the universal "not this". Independent of
      // hover/focus (the flyout below).
      className={[
        'inline-flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
        state && cueOnValue ? ANCHOR_STATE_CLASS[state] : '',
      ].join(' ')}
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
            role="group"
            aria-label={`Filter on ${subject}`}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
            className={[
              'fixed z-50 flex items-center gap-0.5 rounded-md border p-0.5 shadow-md',
              'border-[var(--color-border)] bg-[var(--color-bg-elevated)]',
              'transition-opacity duration-150 motion-reduce:transition-none',
              open && pos ? 'opacity-100' : 'pointer-events-none opacity-0',
            ].join(' ')}
          >
            <FilterActionButton
              polarity="include"
              subject={subject}
              state={state}
              icon={FunnelPlus}
              onActivate={() => activate('include')}
            />
            {onFilterOut && (
              <>
                <span aria-hidden className="h-3.5 w-px bg-[var(--color-border)]" />
                <FilterActionButton
                  polarity="exclude"
                  subject={subject}
                  state={state}
                  icon={FunnelMinus}
                  onActivate={() => activate('exclude')}
                />
              </>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Hover colour, and the pressed look, per polarity: accent for in, error red for out. */
const ACTION_TONE: Record<FilterPolarity, { hover: string; pressed: string }> = {
  include: {
    hover: 'hover:text-[var(--color-accent)]',
    pressed: 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]',
  },
  exclude: {
    hover: 'hover:text-[var(--color-error)]',
    pressed: 'bg-[var(--color-error)]/15 text-[var(--color-error)]',
  },
};

function FilterActionButton({
  polarity,
  subject,
  state,
  icon: Icon,
  onActivate,
}: {
  polarity: FilterPolarity;
  subject: string;
  state: FilterPolarity | null;
  icon: LucideIcon;
  onActivate: () => void;
}) {
  const explanation = filterActionLabel(polarity, subject, state);
  const pressed = state === polarity;
  const tone = ACTION_TONE[polarity];
  return (
    <Tooltip content={explanation}>
      <button
        type="button"
        // Pointer-only: keyboard users act from the anchor (see the header).
        tabIndex={-1}
        aria-label={explanation}
        aria-pressed={pressed}
        onClick={onActivate}
        className={[
          // 24px — the WCAG 2.2 AA target-size floor this package holds inline actions to.
          'flex size-6 items-center justify-center rounded transition-colors duration-150',
          pressed
            ? tone.pressed
            : `text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-raised)] ${tone.hover}`,
        ].join(' ')}
      >
        <Icon className="size-3" aria-hidden />
      </button>
    </Tooltip>
  );
}
