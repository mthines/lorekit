'use client';

/**
 * ActivityIndicator
 *
 * A 2px amber sweep along the bottom edge of the TopBar, shown while anything
 * is being fetched or mutated. It is deliberately chrome, not content: it sits
 * ON the header's existing border rather than adding a row, so nothing below it
 * moves when it appears — a loading affordance that shifts the page is worse
 * than none.
 *
 * A bar rather than a spinner because the work it reports is not owned by any
 * one control: several queries can be in flight at once and the bar spans the
 * whole surface they belong to. Per-view spinners and skeletons stay where they
 * are — this covers the BACKGROUND refreshes (a window-focus refetch, a
 * revalidation after a write) that otherwise happen with no visible sign.
 *
 * Announced politely via a visually hidden `role="status"`: a screen-reader
 * user gets "Refreshing…" once, and nothing at all for the fast requests the
 * delay filters out, rather than a chatty live region on every keystroke-driven
 * refetch.
 */

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useBackgroundActivity } from '@/lib/hooks/useBackgroundActivity';

export function ActivityIndicator() {
  const isBusy = useBackgroundActivity();
  const reduceMotion = useReducedMotion();

  return (
    <>
      <AnimatePresence>
        {isBusy && (
          <motion.div
            // `aria-hidden`: the status text below is the accessible signal —
            // an animated strip has nothing useful to announce on its own.
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -bottom-px h-px overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {reduceMotion ? (
              // Reduced motion: the same amber line, held still. The state is
              // still legible (a line that is there vs not) without a travelling
              // element, which is the part that causes trouble.
              <div className="h-full w-full bg-[var(--color-accent)] opacity-60" />
            ) : (
              <motion.div
                // A short segment travelling the width, not a filling bar: the
                // duration of a refetch is unknown, and a bar that fills implies
                // a completion percentage the app cannot honour.
                className="h-full w-2/5 bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent"
                initial={{ x: '-100%' }}
                animate={{ x: '350%' }}
                transition={{ duration: 1.1, ease: 'easeInOut', repeat: Infinity }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <span role="status" aria-live="polite" className="sr-only">
        {isBusy ? 'Refreshing data' : ''}
      </span>
    </>
  );
}
