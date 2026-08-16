'use client';

/**
 * AnimatedNumber — a number that COUNTS to its new value instead of swapping.
 *
 * Every figure on the dashboard answers a question about a selection, and the
 * selection changes constantly: a scope chip, a filter pill, a range preset.
 * When the answer replaced itself instantly there was nothing to tell a reader
 * that the number in front of them was a NEW answer rather than the old one —
 * the panel dimmed, undimmed, and four figures were quietly different. Counting
 * makes the recomputation visible for ~400ms, which is the whole job: it is a
 * change indicator, not decoration.
 *
 * ## Why the DOM is written directly
 *
 * The tween runs at 60fps. Driving it through `useState` would re-render the
 * card (and its sparkbar, and its tooltip) sixty times a second for a text
 * change; instead the animation owns ONE text node and React never re-renders
 * it — the rendered children are a mount-time constant, so React's reconciler
 * has no text update to make and never fights the tween for the node.
 *
 * ## Two spans, deliberately
 *
 * The counting span is `aria-hidden` and a screen-reader-only sibling carries
 * the real value. A single span would expose whatever intermediate number the
 * tween happened to be on when assistive tech read it — a wrong number, stated
 * confidently. The visible half animates; the announced half is always exact.
 */

import { useContext, useEffect, useRef } from 'react';
import { animate, MotionConfigContext, useReducedMotion } from 'motion/react';

/**
 * Fast enough to read as a recomputation rather than a countdown.
 *
 * The interaction is "the selection changed, here is the new answer" — an
 * acknowledgement, which the interaction catalog puts in the 150–500ms band.
 * Past ~500ms the eye starts WAITING for the number, which is the opposite of
 * what a stat header is for.
 */
const DEFAULT_DURATION = 0.4;

const formatDefault = (value: number) => value.toLocaleString();

export interface AnimatedNumberProps {
  /** The target value. Every change tweens from whatever is on screen. */
  value: number;
  /** Tween length in seconds. */
  duration?: number;
  /**
   * Renders the number. Must be stable-ish — it is read through a ref, so a new
   * function identity each render is harmless (it does not restart the tween).
   */
  format?: (value: number) => string;
  /**
   * Whether the FIRST render counts up from zero. Off by default: a card that
   * mounts already counting competes with the page's own entrance, and a value
   * that is correct the instant it paints is what a stat header promises.
   * Committed visual baselines depend on this too — a mount-time tween would
   * screenshot mid-count.
   */
  animateOnMount?: boolean;
  className?: string;
}

export function AnimatedNumber({
  value,
  duration = DEFAULT_DURATION,
  format = formatDefault,
  animateOnMount = false,
  className = '',
}: AnimatedNumberProps) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  // What is CURRENTLY on screen, not the last committed prop. An interrupted
  // tween (a second scope click before the first settled) must continue from
  // the number the reader can see, or it visibly jumps back to the previous
  // answer before counting again.
  const displayed = useRef(animateOnMount ? 0 : value);
  const formatRef = useRef(format);
  formatRef.current = format;

  // The device preference, plus an enclosing `MotionConfig`'s override.
  //
  // A `motion` component reads both; this one animates through the IMPERATIVE
  // `animate()`, which reads neither, so the two are combined here by hand.
  // Deliberately NOT Motion's exact precedence: `MotionConfigContext` defaults
  // to `reducedMotion: 'never'` when no provider is mounted, and this app has no
  // root `MotionConfig` (components opt in locally) — so honouring `'never'`
  // would let a DEFAULT silently override a real user preference. `'always'` can
  // force reduction; nothing can force motion ON over the device's objection.
  //
  // This is also what makes the committed visual baselines deterministic:
  // `.storybook/preview.tsx` sets `reducedMotion="always"`, so a story is
  // screenshotted at the settled value rather than mid-count.
  const prefersReducedMotion = useReducedMotion();
  const { reducedMotion } = useContext(MotionConfigContext);
  const reduceMotion = reducedMotion === 'always' || Boolean(prefersReducedMotion);

  // Rendered once and then never again: `useRef(...).current` is frozen at
  // mount, so React re-renders produce an identical child and leave the text
  // node alone for the tween to own. Rendering `format(value)` here instead
  // would flash the final number for one frame before the count started.
  const initialText = useRef(format(animateOnMount ? 0 : value)).current;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const write = (n: number) => {
      node.textContent = formatRef.current(n);
    };
    const settle = () => {
      displayed.current = value;
      write(value);
    };

    // Reduced motion gets the answer, just not the journey — and an unchanged
    // value has no journey to make.
    if (reduceMotion || displayed.current === value) {
      settle();
      return;
    }

    const controls = animate(displayed.current, value, {
      duration,
      // Decelerating: fast off the mark so the change registers immediately,
      // easing into the final digits so they are readable as they land.
      ease: 'easeOut',
      onUpdate: (v) => {
        displayed.current = v;
        write(Math.round(v));
      },
      onComplete: settle,
    });
    return () => controls.stop();
    // `format` is deliberately absent — it is read through a ref, so a caller
    // passing an inline formatter cannot restart the tween on every render.
  }, [value, duration, reduceMotion]);

  return (
    <span className={className}>
      <span ref={nodeRef} aria-hidden>
        {initialText}
      </span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
