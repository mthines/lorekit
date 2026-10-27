'use client';

/**
 * The draggable left edge of the desktop memory detail panel.
 *
 * A WAI-ARIA window splitter (`role="separator"`, focusable, with a value): drag
 * it, or focus it and use ← / → (Shift for bigger steps), Home / End; double-
 * click it to go back to the default width.
 *
 * ## Why the drag writes the DOM directly
 *
 * The panel (`LessonDetailSheet`) is a large component — a rendered markdown
 * body, a form, a dozen metadata rows. Re-rendering it on every `pointermove`
 * would make the drag stutter on exactly the long memories a reader widens the
 * panel for. So while a drag (or a held arrow key) is in progress, this writes
 * the panel's `style.width` itself, through the same `panelWidthCss` formatter
 * the panel renders with, and commits ONCE when the gesture ends: one storage
 * write, one panel render, one analytics event. The committed render produces the
 * same string the drag wrote, so React and the DOM agree afterwards.
 *
 * ## Focus
 *
 * `pointerdown` is `preventDefault`ed. That stops the drag from starting a text
 * selection, and it also keeps a pointer drag from moving focus onto the handle —
 * which matters because the desktop drawer is non-modal and the Explorer list is
 * meant to keep keyboard ownership (see the focus notes in `LessonDetailSheet`).
 * Keyboard users reach the handle with Tab, like any other control.
 */

import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { MemoryPanelResizeSource } from '@/lib/analytics/lore-events';
import { useViewportWidth } from '@/lib/hooks/useViewportWidth';
import {
  keyboardPanelWidth,
  panelFractionFromWidth,
  panelWidthBounds,
  panelWidthCss,
  panelWidthPx,
  viewportPercent,
} from '@/lib/lesson-panel-width';

/** A pointer must travel this far before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;

const RESIZE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export interface PanelWidthChange {
  /** The new stored fraction of the viewport, or `null` to go back to the default. */
  fraction: number | null;
  source: MemoryPanelResizeSource;
  /** The share of the viewport the panel now covers — for analytics. */
  viewportPercent: number;
}

interface LessonPanelResizeHandleProps {
  /** The stored width fraction the panel is rendering, or `null` for the default. */
  fraction: number | null;
  /** Persist a finished resize. Called once per gesture, never per pointer move. */
  onCommit: (change: PanelWidthChange) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  /**
   * Where inside the handle the pointer grabbed it, relative to the panel's
   * edge — so the edge does not jump to the cursor on the first move.
   */
  grabOffset: number;
  moved: boolean;
}

export function LessonPanelResizeHandle({ fraction, onCommit }: LessonPanelResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  // The fraction the DOM is showing mid-gesture but that has not been committed.
  const pendingRef = useRef<number | null>(null);
  // Mirrors `pendingRef` for rendering, so `aria-valuenow` follows the drag. Only
  // this small component re-renders on each step — never the panel.
  const [previewFraction, setPreviewFraction] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const viewportWidth = useViewportWidth();

  const shownFraction = previewFraction ?? fraction;

  function panel(): HTMLElement | null {
    return handleRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
  }

  function preview(next: number) {
    const element = panel();
    if (!element) return;
    pendingRef.current = next;
    element.style.width = panelWidthCss(next);
    setPreviewFraction(next);
  }

  function commit(source: MemoryPanelResizeSource) {
    const next = pendingRef.current;
    pendingRef.current = null;
    setPreviewFraction(null);
    if (next === null) return;
    onCommit({ fraction: next, source, viewportPercent: Math.round(next * 100) });
  }

  /** Abandon an uncommitted gesture and put the rendered width back. */
  function revert() {
    pendingRef.current = null;
    setPreviewFraction(null);
    const element = panel();
    if (element) element.style.width = panelWidthCss(fraction);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const element = panel();
    if (!element) return;
    event.preventDefault();
    try {
      // Capture keeps the moves coming while the cursor is over the list.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // `NotFoundError` for a pointer the browser no longer considers active
      // (and for synthetic test pointers). The drag still works while the
      // cursor stays over the handle; it must never throw out of a handler.
    }
    const edgeX = window.innerWidth - element.getBoundingClientRect().width;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      grabOffset: event.clientX - edgeX,
      moved: false,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // A double-click's two presses jitter by a pixel or two; without a threshold
    // each one would commit a "drag" before the reset.
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const viewport = window.innerWidth;
    if (viewport <= 0) return;
    const widthPx = viewport - (event.clientX - drag.grabOffset);
    preview(panelFractionFromWidth(widthPx, viewport));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>, outcome: 'commit' | 'revert') {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (outcome === 'commit') commit('drag');
    else revert();
  }

  function handleDoubleClick() {
    pendingRef.current = null;
    setPreviewFraction(null);
    const viewport = window.innerWidth;
    onCommit({
      fraction: null,
      source: 'reset',
      viewportPercent: viewportPercent(panelWidthPx(null, viewport), viewport),
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const viewport = window.innerWidth;
    if (viewport <= 0) return;
    const current = panelWidthPx(pendingRef.current ?? fraction, viewport);
    const next = keyboardPanelWidth(event.key, { shiftKey: event.shiftKey }, current, viewport);
    if (next === null) return;
    event.preventDefault();
    preview(panelFractionFromWidth(next, viewport));
  }

  // A held arrow key repeats `keydown`; committing on `keyup` (or on blur, if
  // focus leaves mid-hold) makes one press-and-hold one change, like one drag.
  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (RESIZE_KEYS.has(event.key)) commit('keyboard');
  }

  const bounds = viewportWidth === null ? null : panelWidthBounds(viewportWidth);
  const valueNow = viewportWidth === null ? null : Math.round(panelWidthPx(shownFraction, viewportWidth));

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize memory panel"
      aria-controls="lesson-detail-panel"
      aria-valuemin={bounds ? Math.round(bounds.min) : undefined}
      aria-valuemax={bounds ? Math.round(bounds.max) : undefined}
      aria-valuenow={valueNow ?? undefined}
      aria-valuetext={valueNow === null ? undefined : `${valueNow} pixels wide`}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-testid="lesson-panel-resize-handle"
      data-resizing={dragging ? '' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => endDrag(event, 'commit')}
      onPointerCancel={(event) => endDrag(event, 'revert')}
      onLostPointerCapture={(event) => endDrag(event, 'commit')}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={() => {
        // A pointer drag finishes on pointerup, not here; this only catches a
        // held arrow key whose keyup never arrives because focus moved away.
        if (!dragRef.current) commit('keyboard');
      }}
      // 24px wide (the hit-target floor), centred on the panel's left border:
      // half over the list, half over the panel's 20px header/body padding, so
      // it never sits on top of a control. Invisible until hovered, focused or
      // dragged — the cursor is the affordance, as in most editors.
      className="group/resize absolute inset-y-0 -left-3 z-10 w-6 cursor-col-resize touch-none select-none focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-[var(--color-accent)] group-focus-visible/resize:bg-[var(--color-accent)] group-data-[resizing]/resize:bg-[var(--color-accent)]"
      />
    </div>
  );
}
