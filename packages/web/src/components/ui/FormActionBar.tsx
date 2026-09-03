'use client';

/**
 * FormActionBar
 *
 * A reusable floating action bar that appears at the bottom of a panel/sidebar
 * whenever a form has unsaved changes. Shows "Save" and "Discard" actions plus
 * an optional server-error message.
 *
 * ## Animation
 * Slides up from the bottom and fades in when dirty; reverses on exit.
 * Uses Motion (not framer-motion) — GPU-safe transform + opacity only.
 * Easing matches the existing sidebar panel: ease-out-smooth [0.16, 1, 0.3, 1].
 * `prefers-reduced-motion` is respected via the global CSS rule in globals.css
 * (which collapses all transition/animation durations to 0.01 ms) AND via
 * `useReducedMotion()` which disables the y-translate so no layout shift occurs.
 *
 * ## Reusability
 * The component is purely presentational — it renders given the `isDirty`,
 * `isSaving`, and `saveError` flags plus the two callbacks. It has no knowledge
 * of react-hook-form. Wire it to `useEditableForm`'s return values.
 *
 * @example
 * ```tsx
 * <FormActionBar
 *   isDirty={form.isDirty}
 *   isSaving={form.isSaving}
 *   saveError={form.saveError}
 *   onSave={form.handleSubmit}
 *   onDiscard={form.discard}
 * />
 * ```
 */

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, RotateCcw, AlertCircle } from 'lucide-react';

import { Button } from './Button';

export interface FormActionBarProps {
  /** Show the bar only when there are unsaved changes. */
  isDirty: boolean;
  /** True while the save request is in flight. */
  isSaving: boolean;
  /** Server-side error message, if any. */
  saveError?: string | null;
  /** Called when the user clicks Save (or presses Cmd/Ctrl+S). */
  onSave: (e?: React.BaseSyntheticEvent) => Promise<void> | void;
  /** Called when the user clicks Discard (or presses Escape). */
  onDiscard: () => void;
  /** Optional class name forwarded to the outer wrapper. */
  className?: string;
}

export function FormActionBar({
  isDirty,
  isSaving,
  saveError,
  onSave,
  onDiscard,
  className = '',
}: FormActionBarProps) {
  const reducedMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {isDirty && (
        <motion.div
          key="form-action-bar"
          initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className={[
            'border-t border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4',
            className,
          ].join(' ')}
          // Announce to screen readers that the bar appeared.
          role="region"
          aria-label="Unsaved changes"
          aria-live="polite"
        >
          {/* Error message */}
          {saveError && (
            <motion.p
              key="save-error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mb-3 flex items-center gap-1.5 text-xs text-[var(--color-error)]"
              role="alert"
            >
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              {saveError}
            </motion.p>
          )}

          {/* Unsaved-changes hint */}
          <p className="mb-3 text-xs text-[var(--color-content-tertiary)]">
            You have unsaved changes
          </p>

          {/* Action buttons */}
          <div className="flex gap-2">
            {/* Discard */}
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              analyticsId="form-action-bar.discard"
              onClick={onDiscard}
              disabled={isSaving}
              aria-label="Discard changes"
              leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
            >
              Discard
            </Button>

            {/* Save */}
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              analyticsId="form-action-bar.save"
              onClick={(e) => void onSave(e)}
              isLoading={isSaving}
              aria-label={isSaving ? 'Saving…' : 'Save changes'}
              leftIcon={<Check className="size-3.5" aria-hidden />}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>

          {/* Keyboard hint — hidden on mobile (pointer: coarse) */}
          <p className="mt-2 hidden text-center text-[10px] text-[var(--color-content-tertiary)] [pointer-events:none] [@media(pointer:fine)]:block">
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1 py-0.5 font-mono text-[9px]">
              ⌘S
            </kbd>{' '}
            to save ·{' '}
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1 py-0.5 font-mono text-[9px]">
              Esc
            </kbd>{' '}
            to discard
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
