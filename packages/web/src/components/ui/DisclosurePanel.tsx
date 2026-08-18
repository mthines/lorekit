'use client';

/**
 * The animated half of a disclosure — one panel that opens and closes under a
 * trigger.
 *
 * Three surfaces on the API-keys page expand: the "New token" form, the scoping
 * fieldset inside it, and the per-key scoping editor. Before this they were
 * three different things — one animated its own `height` with a single 200 ms
 * curve shared with `opacity`, and the other two appeared instantly. Nesting an
 * un-animated panel inside an animated one is what made the surface feel broken
 * rather than merely plain, so the motion lives in one component and all three
 * use it.
 *
 * ## The choreography, and why it is two beats
 *
 * One tween that grows the box and fades the content together renders the
 * content at full opacity while the box is still a few pixels tall — the text
 * reflows as the box grows, which reads as a squash. So:
 *
 *   opening — the box grows first, the content lands 60 ms behind it
 *   closing — the content leaves first, the box follows
 *
 * The content beat is `transform`/`opacity` only (GPU). The box's height is
 * layout work, which is unavoidable for an open-to-`auto` panel, and is exactly
 * why the other beat is kept cheap.
 *
 * ## Timing
 *
 * 260 ms open, 180 ms close — the accordion band (240–320 open, ~200 close).
 * The close is faster on purpose: someone who just collapsed a panel has moved
 * on, and making them wait for it is the most common way a correct animation
 * still feels slow.
 *
 * Opening uses the repo's `--ease-out-smooth` (`cubic-bezier(0.16,1,0.3,1)`),
 * the curve the rest of the dashboard opens with. Closing accelerates instead,
 * so the panel leaves rather than drifting away.
 *
 * ## Reduced motion
 *
 * `globals.css` neutralises CSS transitions under
 * `prefers-reduced-motion: reduce`, and that rule does NOT reach Motion, which
 * animates from JS. So the preference is read here and every duration collapses
 * to zero: the state change still happens, it just happens at once.
 *
 * ## Why the panel unmounts
 *
 * `disclosure.ts` argues for keeping the panel mounted behind `hidden`, and its
 * `disclosurePanelProps` does exactly that. It is not used here because a
 * `hidden` element is `display: none` and cannot be animated — the panel would
 * have to be un-hidden a frame early and re-hidden on completion, which is two
 * more states to get wrong than this is worth. Unmounting keeps the property
 * that matters most (the collapsed content is out of the tab order and out of
 * find-in-page), and `aria-expanded` — from the same module's tested trigger
 * helper — remains the authoritative state.
 */

import { useEffect, useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { disclosureTriggerProps, type DisclosureTriggerProps } from './disclosure';

/** `--ease-out-smooth` from `globals.css`, in the form Motion wants. */
const EASE_OUT_SMOOTH = [0.16, 1, 0.3, 1] as const;
/** Accelerate — an exit should leave, not drift. */
const EASE_ACCELERATE = [0.4, 0, 1, 1] as const;

const OPEN_S = 0.26;
const CLOSE_S = 0.18;
/** The content follows the box rather than racing it. */
const CONTENT_LAG_S = 0.06;

/**
 * Wire a trigger and a panel together with one id.
 *
 * The trigger props come from the repo's tested pure helper, so a caller cannot
 * get `aria-expanded` right and `aria-controls` wrong — or omit the second,
 * which is what all three of these surfaces originally did.
 */
export function useDisclosure(open: boolean): {
  panelId: string;
  triggerProps: DisclosureTriggerProps;
} {
  const panelId = useId();
  return { panelId, triggerProps: disclosureTriggerProps(open, panelId) };
}

export interface DisclosurePanelProps {
  open: boolean;
  /** From `useDisclosure`, so the trigger's `aria-controls` resolves. */
  id: string;
  children: ReactNode;
  /** Extra classes on the INNER content wrapper, not the clipping box. */
  className?: string;
}

export function DisclosurePanel({ open, id, children, className = '' }: DisclosurePanelProps) {
  const reduceMotion = useReducedMotion();
  const instant = { duration: 0 };

  // The clip is needed only while the height is moving. Left on permanently it
  // cuts the focus ring off whatever sits against the panel's edge — on a form
  // this size that is a real regression for keyboard users, and an invisible
  // one for everyone else, which is how it survives review. Tracked in state
  // rather than poked onto the node so the two directions cannot disagree.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!open) setSettled(false);
  }, [open]);

  return (
    // `initial={false}` so a panel that is already open on first render — the
    // row editor seeds itself open — does not play an entrance nobody asked for.
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          key="panel"
          initial={{ height: 0 }}
          animate={{ height: 'auto' }}
          exit={{
            height: 0,
            transition: reduceMotion ? instant : { duration: CLOSE_S, ease: EASE_ACCELERATE },
          }}
          transition={reduceMotion ? instant : { duration: OPEN_S, ease: EASE_OUT_SMOOTH }}
          style={{ overflow: settled ? 'visible' : 'hidden' }}
          onAnimationComplete={() => setSettled(open)}
        >
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{
              opacity: 0,
              y: -4,
              // Leaves first and quickly, so the box is closing over content
              // that has already gone rather than over readable text.
              transition: reduceMotion ? instant : { duration: CLOSE_S * 0.6, ease: EASE_ACCELERATE },
            }}
            transition={
              reduceMotion
                ? instant
                : { duration: OPEN_S - CONTENT_LAG_S, delay: CONTENT_LAG_S, ease: EASE_OUT_SMOOTH }
            }
            className={className}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
