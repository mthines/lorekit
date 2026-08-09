'use client';

/**
 * BottomSheet
 *
 * A native-feeling bottom sheet for the phone breakpoint: a full-width panel
 * that slides up from the bottom edge over a blurred backdrop, with a grab
 * handle you can drag down to close. Isolated and reusable — it owns none of
 * its content, only the surface, the dismissal gestures, and the a11y wiring —
 * so any mobile picker (the Lore Explorer's `FilterMenu`, a future action
 * menu, a confirm flow) can drop its body inside.
 *
 * ## Why a sheet and not the desktop popover on mobile
 * An anchored popover assumes a mouse and a large viewport: it opens beside its
 * trigger, is dismissed by a precise click-outside, and can overflow a narrow
 * screen. A sheet is the platform-native shape for the same job on a phone —
 * thumb-reachable at the bottom, dismissed by the two gestures a user already
 * expects (tap the backdrop, drag it down), and never wider than the screen.
 *
 * ## Dismissal
 * Three ways out, matching the platform: tap the backdrop, press Escape, or
 * drag down past a threshold (or flick it — see `shouldDismissSheet` in
 * `bottom-sheet.ts`). A short, slow pull springs back. The drag can start on
 * the handle *or* on the body content — a body pull only becomes a drag when
 * the content under the finger is not a scroll area (`onBodyPointerDown`), so a
 * scrollable list still scrolls.
 *
 * ## Motion (see /animations "sheet / drawer")
 * Enters by translating up from fully off-screen and leaves the same way;
 * `useReducedMotion` collapses both to a fade. Drag is a real transform driven
 * by `useDragControls`, started from the handle unconditionally and from a
 * non-scrolling body on pointer-down. Pulling *above* the resting top
 * rubber-bands a little and springs back (`SHEET_DRAG_ELASTIC`); the panel
 * extends an `OVERSCROLL_BUFFER` below the fold so that up-drag never opens a
 * gap under the sheet.
 *
 * ## Portal + `container`
 * Rendered through a portal so the sheet escapes any `overflow`/stacking
 * context of the control that opened it. In the app that portal is
 * `document.body` and the sheet is `fixed` to the viewport. Stories pass a
 * `container` (a positioned device-frame element) so the sheet is `absolute`
 * within it and a screenshot of the frame captures it.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls, useReducedMotion } from 'motion/react';

import { OVERSCROLL_BUFFER, SHEET_DRAG_ELASTIC, shouldDismissSheet } from './bottom-sheet';

/**
 * Nearest vertically-scrollable ancestor of `start`, searched up to and
 * including `boundary` (the sheet body). Returns null when no element in that
 * chain can actually scroll — i.e. the content fits. This is what lets a
 * body-drag respect a *nested* scroll region (the Explorer's `FilterMenu`
 * scrolls its value list, not the sheet body itself) instead of hijacking it.
 */
function nearestScrollableY(start: Element | null, boundary: Element): HTMLElement | null {
  let el: Element | null = start;
  while (el) {
    if (el instanceof HTMLElement) {
      const overflowY = getComputedStyle(el).overflowY;
      const scrolls = overflowY === 'auto' || overflowY === 'scroll';
      // +1 guards against sub-pixel rounding reporting a non-scrolling element
      // as scrollable.
      if (scrolls && el.scrollHeight > el.clientHeight + 1) return el;
    }
    if (el === boundary) break;
    el = el.parentElement;
  }
  return null;
}

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also becomes the sheet's accessible name. */
  title?: string;
  /** Accessible name when there is no visible `title`. Required if `title` is omitted. */
  ariaLabel?: string;
  children: ReactNode;
  /**
   * Portal target. Defaults to `document.body` (sheet `fixed` to the viewport).
   * Pass a positioned (`relative`) element to contain the sheet inside it —
   * Storybook uses this to render the sheet inside a device frame it can snapshot.
   */
  container?: HTMLElement | null;
  /** Extra classes on the sheet panel. */
  className?: string;
}

export function BottomSheet({
  open,
  onClose,
  title,
  ariaLabel,
  children,
  container,
  className = '',
}: BottomSheetProps) {
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Start a sheet drag from the body — but only when the content under the
  // finger is NOT a scroll area, so a scrollable list still scrolls (the
  // "unless it's a scroll area" rule). Starting on pointer-DOWN, the way the
  // handle does, is what makes this work on touch: deferring to a pointer-move
  // lets the browser claim the gesture as a scroll first, after which Motion
  // never sees it. `dragListener` is off on the panel, so the sheet only ever
  // drags from an explicit `dragControls.start`. A tap that never moves closes
  // nothing (offset ~0) and its click still fires, so selection is unaffected.
  function onBodyPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary) return;
    const body = bodyRef.current;
    if (!body) return;
    if (nearestScrollableY(e.target as Element, body)) return;
    dragControls.start(e);
  }

  // When contained (Storybook), the sheet is absolute within the frame and must
  // not touch the real viewport (no body scroll lock, no fixed positioning).
  const contained = container != null;

  // Resolve the portal target after mount so SSR renders nothing (document is
  // client-only) and AnimatePresence can still own the mounted subtree.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(container ?? document.body);
  }, [container]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll behind the (viewport-level) sheet so the page doesn't
  // scroll under it. Skipped when contained — the frame isn't the viewport.
  useEffect(() => {
    if (!open || contained) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, contained]);

  // Make everything behind the sheet inert while it is open, so Tab and
  // assistive tech cannot reach page content the modal claims is unavailable
  // (`aria-modal`). The portal root is a direct child of <body>, so its
  // siblings are the page; `inert` removes them from the tab order and the a11y
  // tree in one attribute. Skipped when contained — the frame is not the
  // viewport — and any element already inert is left inert on cleanup.
  useEffect(() => {
    if (!open || contained) return;
    const root = overlayRef.current;
    if (!root || root.parentElement !== document.body) return;
    const siblings = (Array.from(document.body.children) as HTMLElement[]).filter(
      (el) => el !== root,
    );
    const wasInert = siblings.map((el) => el.hasAttribute('inert'));
    siblings.forEach((el) => el.setAttribute('inert', ''));
    return () => {
      siblings.forEach((el, i) => {
        if (!wasInert[i]) el.removeAttribute('inert');
      });
    };
    // `target` is a dep so a sheet mounted already-open still inerts: the first
    // run happens before the portal commits (overlayRef null → early return),
    // and re-runs once `target` resolves and the overlay exists.
  }, [open, contained, target]);

  // Move focus into the sheet on open and restore it to the opener on close —
  // the baseline dialog contract. A child that manages its own focus (e.g. a
  // search input) can still steal it afterwards; this only guarantees focus is
  // never left on an element now hidden behind the backdrop.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      // Defer past the mount so the panel exists to receive focus. Yield if a
      // child already grabbed focus (e.g. a search input) — this is only a
      // floor: never leave focus on an element now hidden behind the backdrop.
      const id = requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (panel && !panel.contains(document.activeElement)) panel.focus();
      });
      return () => cancelAnimationFrame(id);
    }
    restoreFocusRef.current?.focus?.();
  }, [open]);

  if (!target) return null;

  const position = contained ? 'absolute' : 'fixed';
  const labelledBy = title ? titleId : undefined;
  const label = title ? undefined : ariaLabel;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div ref={overlayRef} className={`${position} inset-0 z-50 flex flex-col justify-end`}>
          {/* Blurred backdrop — tap to dismiss. */}
          <motion.div
            aria-hidden
            data-testid="bottom-sheet-backdrop"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={`${position} inset-0 bg-black/50 backdrop-blur-sm`}
          />

          {/* Sheet panel. */}
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal={contained ? undefined : true}
            aria-labelledby={labelledBy}
            aria-label={label}
            tabIndex={-1}
            drag="y"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={SHEET_DRAG_ELASTIC}
            onDragEnd={(_event, info) => {
              if (shouldDismissSheet({ offsetY: info.offset.y, velocityY: info.velocity.y })) {
                onClose();
              }
            }}
            initial={reduceMotion ? { opacity: 0 } : { y: '100%' }}
            animate={reduceMotion ? { opacity: 1 } : { y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { y: '100%' }}
            transition={
              reduceMotion
                ? { duration: 0.15 }
                : { type: 'spring', damping: 34, stiffness: 340 }
            }
            style={{
              // The panel is a programmatic focus target (tabIndex -1, not
              // Tab-reachable), so it takes no visible focus ring — inner
              // controls keep theirs. An inline `outline: none` is required: the
              // app's global `:focus-visible { outline: accent }` is unlayered,
              // so it outranks any Tailwind `outline-none` utility (in
              // `@layer utilities`); only inline style wins the cascade.
              // Otherwise the outline paints an amber edge along the sheet's top.
              outline: 'none',
              // Over-scroll buffer. When a pull past the top translates the sheet
              // up, its bottom edge would lift off the screen and expose the
              // backdrop as a gap. Extending the panel below the fold with a
              // buffer of extra bottom padding, then pulling it back down by the
              // same amount with a negative margin, keeps the visible content
              // flush at the bottom at rest while the buffer covers the gap for
              // any up-drag within it. The safe-area inset (home indicator) is
              // added on top so the last row still clears it. `max-h` grows by
              // the same buffer so a full-height sheet keeps its visible 90%.
              paddingBottom: `calc(env(safe-area-inset-bottom) + ${OVERSCROLL_BUFFER})`,
              marginBottom: `-${OVERSCROLL_BUFFER}`,
              maxHeight: `calc(90% + ${OVERSCROLL_BUFFER})`,
            }}
            className={[
              'relative flex w-full flex-col overflow-hidden rounded-t-2xl border-t border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl',
              className,
            ].join(' ')}
          >
            {/* Drag region: the handle strip plus the title. Grabbing anywhere
                here starts the drag unconditionally; the body below drags only
                when the content under the finger is not a scroll area (see
                `onBodyPointerDown`). `touch-none` stops the browser claiming the
                gesture as a scroll before motion sees it. */}
            <div
              data-testid="bottom-sheet-drag-handle"
              onPointerDown={(e) => dragControls.start(e)}
              className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
            >
              <div className="flex justify-center pb-1 pt-2.5">
                <span
                  aria-hidden
                  className="h-1 w-9 rounded-full bg-[var(--color-border)]"
                />
              </div>
              {title && (
                <h2
                  id={titleId}
                  className="px-4 pb-2 pt-1 text-sm font-medium text-[var(--color-content-primary)]"
                >
                  {title}
                </h2>
              )}
            </div>

            {/* Body — the caller's content. Kept scrollable so a long list
                never pushes the sheet past its max height. A pull that starts
                here also drags the sheet to close, but only when the content
                under the finger is not a live scroll area (see
                `onBodyPointerDown`). `overscroll-contain` keeps a scroll from
                chaining out to the sheet edge. */}
            <div
              ref={bodyRef}
              onPointerDown={onBodyPointerDown}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    target,
  );
}
