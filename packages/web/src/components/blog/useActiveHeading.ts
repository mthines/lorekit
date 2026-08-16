'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TocItem } from '@/lib/blog/toc';
import { resolveActiveHeadingId } from '@/lib/analytics/reading';

/** The "reading line" (px from viewport top): a heading is the active section
 *  once its top rises above this. Deliberately a hair BELOW `BlogProse`'s
 *  `scroll-mt-28` (7rem = 112px) resting position — so a heading you click/anchor
 *  to (which lands at ~112px) counts as active, instead of leaving the previous
 *  section lit. */
const ACTIVE_OFFSET = 128;

/**
 * Scroll-spy state shared by the desktop rail and the mobile disclosure so both
 * highlight the same section from one source of truth. The active id is resolved
 * from live heading positions: an `IntersectionObserver` wakes the resolver as
 * headings cross the active line, and a rAF-throttled `scroll`/`resize` listener
 * covers the edges the observer can't — notably the page bottom, where a short
 * final section's heading never reaches the line, so there the last item wins.
 *
 * `navigate(id)` scrolls to a section (reduced-motion aware), moves focus to it
 * so a keyboard/screen-reader user continues from there rather than the rail, and
 * updates the URL fragment. Returns `false` if the target heading is missing, so
 * a caller can fall back to native anchor navigation.
 */
export function useActiveHeading(items: readonly TocItem[]) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? '');
  const prefersReducedRef = useRef(false);

  const resolveActive = useCallback(() => {
    // The resolution itself is pure and lives in `lib/analytics/reading.ts`,
    // shared with `ReadingTelemetry`: the section we highlight and the section
    // we bill reading time to must be the same section, by construction.
    const positions = items
      .map(({ id }) => {
        const el = document.getElementById(id);
        return el ? { id, top: el.getBoundingClientRect().top } : null;
      })
      .filter((p): p is { id: string; top: number } => p !== null);
    const doc = document.documentElement;
    const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
    setActiveId(resolveActiveHeadingId(positions, { offset: ACTIVE_OFFSET, atBottom }));
  }, [items]);

  useEffect(() => {
    prefersReducedRef.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const elements = items
      .map(({ id }) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // rAF-throttle so a burst of scroll/observer events collapses to one resolve
    // per frame — the position scan is cheap but shouldn't run per event.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resolveActive();
      });
    };

    const observer = new IntersectionObserver(schedule, {
      rootMargin: `-${ACTIVE_OFFSET}px 0px -66% 0px`,
      threshold: [0, 1],
    });
    for (const el of elements) observer.observe(el);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    resolveActive(); // initial paint (deep-links + top-of-page)
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items, resolveActive]);

  const navigate = useCallback((id: string): boolean => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({
      behavior: prefersReducedRef.current ? 'auto' : 'smooth',
      block: 'start',
    });
    // Move focus to the section so a keyboard/screen-reader user continues from
    // there. `tabindex=-1` makes the heading programmatically focusable without
    // adding it to the tab order; `preventScroll` avoids a second jump.
    el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    history.replaceState(null, '', `#${id}`);
    setActiveId(id);
    return true;
  }, []);

  return { activeId, navigate };
}
