'use client';

/**
 * GettingStartedDialog — large scrollable modal with the full setup guide,
 * accessible from the login page without authentication.
 *
 * Follows the same AnimatePresence + motion.div pattern as ConfirmDialog and
 * LessonDetailSheet: backdrop click closes, Escape closes, focus is trapped
 * and restored. Sized for reading comfort (max-w-2xl) with an overflow-y-auto
 * body so long content stays reachable on small screens.
 */

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { GettingStartedContent } from '@/components/learn/GettingStartedContent';

interface GettingStartedDialogProps {
  open: boolean;
  onClose: () => void;
}

export function GettingStartedDialog({ open, onClose }: GettingStartedDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  // Focus management: remember trigger element, move focus to close button on
  // open, restore on close — mirrors ConfirmDialog / LessonDetailSheet.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => closeRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    previouslyFocused.current?.focus?.();
    return undefined;
  }, [open]);

  // Escape closes; Tab / Shift+Tab are trapped inside the dialog.
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="gs-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          {/* Dialog panel */}
          <motion.div
            key="gs-dialog"
            ref={dialogRef}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, y: reduceMotion ? 0 : 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, y: reduceMotion ? 0 : 12 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-1/2 z-[51] flex w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl"
            style={{ maxHeight: 'min(90dvh, 800px)' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="gs-dialog-title"
          >
            {/* Sticky header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
              <h2
                id="gs-dialog-title"
                className="text-base font-semibold text-[var(--color-content-primary)]"
              >
                Setup guide
              </h2>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close setup guide"
                className="flex size-8 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto p-6">
              <GettingStartedContent isPublic />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
