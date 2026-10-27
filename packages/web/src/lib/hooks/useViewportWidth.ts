'use client';

import { useSyncExternalStore } from 'react';

/**
 * The viewport's width in CSS pixels (`window.innerWidth`, the box `vw` units
 * resolve against), re-rendering on resize.
 *
 * Same shape as `useMediaQuery` next door: `useSyncExternalStore` over ONE shared
 * `resize` listener, so N consumers cost one listener. Unlike a media query this
 * changes on every resize step, so subscribe to it from SMALL components only —
 * the memory panel's resize handle, not the panel itself (the panel's width is a
 * CSS `clamp()` and needs no re-render to follow the window).
 *
 * The server snapshot is `null`: there is no viewport to measure, and `0` would
 * read as a real (and absurd) width.
 */

const subscribers = new Set<() => void>();

function notifyAll(): void {
  subscribers.forEach((notify) => notify());
}

function subscribe(onStoreChange: () => void): () => void {
  if (subscribers.size === 0) window.addEventListener('resize', notifyAll);
  subscribers.add(onStoreChange);
  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0) window.removeEventListener('resize', notifyAll);
  };
}

export function useViewportWidth(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth,
    () => null,
  );
}
