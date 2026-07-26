'use client';

/**
 * ConfirmDialog — the one reusable confirm primitive for destructive actions
 * (leave / delete / remove / revoke). Focus-managed (focus moves to the
 * confirm button on open) and Escape-closable, mirroring
 * `LessonDetailSheet`'s focus handling. Cancel and confirm render with
 * symmetric visual weight and copy — no confirmshaming, no pre-checked
 * opt-ins (plan.md Decision D7 / ux-design accessibility checklist).
 */

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Renders the confirm button and icon in the error/warning treatment. */
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  // On open: remember the triggering element and move focus to the SAFE Cancel
  // action (never the destructive confirm — a stray Enter must not destroy).
  // On close: restore focus to the trigger. Mirrors LessonDetailSheet's
  // focus-on-open + restore-on-close pattern.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => cancelRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    previouslyFocused.current?.focus?.();
    return undefined;
  }, [open]);

  // Escape cancels; Tab / Shift+Tab are trapped within the dialog so focus can
  // never reach the inert background behind an aria-modal dialog.
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCancel();
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
  }, [open, onCancel]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="confirm-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={onCancel}
            aria-hidden
          />
          <motion.div
            key="confirm-dialog"
            ref={dialogRef}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-1/2 z-[51] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
          >
            <div className="mb-3 flex items-center gap-2">
              {destructive && (
                <AlertTriangle className="size-4 shrink-0 text-[var(--color-error)]" aria-hidden />
              )}
              <h2 id="confirm-dialog-title" className="text-sm font-semibold text-[var(--color-content-primary)]">
                {title}
              </h2>
            </div>
            <p id="confirm-dialog-description" className="mb-4 text-xs leading-relaxed text-[var(--color-content-secondary)]">
              {description}
            </p>
            <div className="flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={onCancel}
                className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending}
                className={[
                  'flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium transition-opacity duration-150 disabled:opacity-50',
                  destructive
                    ? 'bg-[var(--color-error)] text-[#1a0000] hover:opacity-90'
                    : 'bg-[var(--color-accent)] text-[#000] hover:opacity-90',
                ].join(' ')}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
