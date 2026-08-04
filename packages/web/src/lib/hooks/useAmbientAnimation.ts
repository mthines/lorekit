'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  ON_SCREEN_WHEN_UNOBSERVABLE,
  canObserve,
  isPageVisible,
  onScreenFrom,
  shouldAnimate,
} from '@/lib/ambient-animation';

/**
 * Gate a decorative, self-looping animation on "visible to a visitor who is
 * actually here" — the impure shell around `lib/ambient-animation.ts`.
 *
 * Returns a callback ref to attach to the animated subtree's root and a boolean
 * the animation loop should check before scheduling more work. See the rule
 * module for why an ungated ambient loop is a CLS and INP cost.
 *
 * Fails OPEN: a browser with no `IntersectionObserver` reports `onScreen: true`,
 * so the animation runs exactly as it did before rather than silently never
 * starting. A decorative animation must degrade to "plays too much", never to
 * "the panel is empty".
 *
 * A callback ref rather than a `RefObject` because the observed node is mounted
 * by the caller's own render: an effect keyed on a ref object cannot see the
 * node arriving, so it would observe `null` on the first pass.
 *
 * Every decision this hook makes — fail open, whether a node is observable yet,
 * which entry to believe, what counts as the foreground tab — is delegated to
 * the pure rule module and covered by `ambient-animation.spec.ts`. What is left
 * here is wiring (`observe` / `disconnect`, the `visibilitychange` listener),
 * which needs jsdom + `@testing-library/react`; neither is a dependency of this
 * package yet, so that half is deliberately uncovered rather than pretended.
 */
export function useAmbientAnimation(): [(node: Element | null) => void, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [onScreen, setOnScreen] = useState(ON_SCREEN_WHEN_UNOBSERVABLE);
  const [pageVisible, setPageVisible] = useState(true);

  const ref = useCallback((next: Element | null) => setNode(next), []);

  useEffect(() => {
    if (!canObserve(node, typeof IntersectionObserver !== 'undefined')) return undefined;

    const observer = new IntersectionObserver(
      (entries) => setOnScreen((current: boolean) => onScreenFrom(entries, current)),
      // A sliver on screen still counts: the visitor can see it, so it should
      // be playing. The point is to stop work for a panel that is genuinely
      // nowhere near the viewport, not to demand it be centred.
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const sync = () => setPageVisible(isPageVisible(document.visibilityState));
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return [ref, shouldAnimate({ onScreen, pageVisible })];
}
