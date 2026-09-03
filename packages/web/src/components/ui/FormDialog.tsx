'use client';

/**
 * FormDialog — a transient surface for a small FORM, split the repo way: an
 * anchored, centred modal at `md`+ and a `BottomSheet` on the phone breakpoint
 * (the same rule `Combobox` / `ScopeSelector` / `FilterMenu` follow). Unlike
 * `ConfirmDialog` — which owns its title/description/confirm/cancel copy — this
 * one owns only the surface, the dismissal, and the a11y wiring, and renders
 * whatever body the caller hands it. Reach for `ConfirmDialog` for a yes/no
 * question; reach for this when the body is a form with its own controls.
 *
 * ## Motion (see /animations "dialog")
 * Desktop enters by scaling 0.97 → 1 with a fade over ~220ms ease-out and
 * leaves the reverse ~30% faster; `useReducedMotion` collapses both to a fade.
 * Mobile hands the motion to `BottomSheet`, which already animates and already
 * honours reduced motion. Transform + opacity only, so it stays on the GPU.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { BottomSheet } from './BottomSheet';
import { IconButton } from './Button';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';

export interface FormDialogProps {
  open: boolean;
  /** Visible heading; also the sheet's accessible name on mobile. */
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra classes on the desktop panel (e.g. a wider `max-w-*`). */
  className?: string;
}

export function FormDialog({ open, title, description, onClose, children, className = '' }: FormDialogProps) {
  const isMobile = useIsMobile();
  const reduceMotion = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // Focus the first field on open, restore focus to the trigger on close.
  // Desktop only — the BottomSheet manages its own focus on mobile.
  useEffect(() => {
    if (isMobile) return undefined;
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => {
        const root = dialogRef.current;
        if (!root) return;
        const first = root.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        (first ?? root).focus();
      }, 80);
      return () => clearTimeout(timer);
    }
    previouslyFocused.current?.focus?.();
    return undefined;
  }, [open, isMobile]);

  // Escape closes; Tab / Shift+Tab are trapped inside the dialog so focus can
  // never reach the inert background. Mirrors `ConfirmDialog`.
  useEffect(() => {
    if (!open || isMobile) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isMobile, onClose]);

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} title={title}>
        <div className="flex flex-col gap-4 px-4 pb-4 pt-1">
          {description && (
            <p className="text-xs leading-relaxed text-[var(--color-content-secondary)]">{description}</p>
          )}
          {children}
        </div>
      </BottomSheet>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="form-dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.15 } }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            key="form-dialog-panel"
            ref={dialogRef}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            animate={{
              opacity: 1,
              scale: 1,
              transition: { duration: reduceMotion ? 0 : 0.22, ease: 'easeOut' },
            }}
            exit={
              reduceMotion
                ? { opacity: 0, transition: { duration: 0 } }
                : { opacity: 0, scale: 0.97, transition: { duration: 0.15, ease: 'easeOut' } }
            }
            className={[
              'fixed left-1/2 top-1/2 z-[51] flex max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl',
              className,
            ].join(' ')}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
              <div className="flex min-w-0 flex-col gap-1">
                <h2 id={titleId} className="text-sm font-semibold text-[var(--color-content-primary)]">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="text-xs leading-relaxed text-[var(--color-content-secondary)]">
                    {description}
                  </p>
                )}
              </div>
              <IconButton
                variant="ghost"
                icon={<X className="size-4" />}
                label="Close"
                analyticsId="form-dialog.close"
                onClick={onClose}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
