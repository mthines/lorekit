'use client';

/**
 * Whether an element has come within `rootMargin` of the viewport — ONCE.
 *
 * The visual Insights page defers its below-the-fold sections (runs, the scope
 * leaderboard) until a reader scrolls near them, so a page load or a range
 * switch does not fire every query on the page at the same moment: the API's
 * slowest aggregates share one database, and a burst of a dozen concurrent
 * requests is what pushed the delivery-cost query past its statement timeout.
 *
 * Latching (never flipping back to false) keeps a section's data and scroll
 * height stable once it has loaded. Without IntersectionObserver (old browsers,
 * some test environments) it reports in-view immediately — deferral is an
 * optimisation, never a reason for content to be missing.
 */

import { useEffect, useState } from 'react';

export function useInView<T extends Element>(rootMargin = '300px') {
  const [element, setElement] = useState<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, inView, rootMargin]);

  return { ref: setElement, inView };
}
