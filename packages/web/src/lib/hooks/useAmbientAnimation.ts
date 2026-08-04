'use client';

import { useCallback, useEffect, useState } from 'react';

import { shouldAnimate } from '@/lib/ambient-animation';

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
 */
export function useAmbientAnimation(): [(node: Element | null) => void, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);

  const ref = useCallback((next: Element | null) => setNode(next), []);

  useEffect(() => {
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setOnScreen(entry.isIntersecting);
      },
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

    const sync = () => setPageVisible(document.visibilityState === 'visible');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return [ref, shouldAnimate({ onScreen, pageVisible })];
}
