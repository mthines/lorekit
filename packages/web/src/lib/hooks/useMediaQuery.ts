'use client';

import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 *
 * SSR-safe: returns `false` on the server and the first client render (there is
 * no `window` to measure), then corrects on mount. That's fine for the only use
 * so far — choosing a modal's presentation (right drawer vs. bottom sheet),
 * which mounts client-side on user interaction, never during SSR.
 *
 * Exists because a responsive choice that drives JavaScript — Framer Motion
 * `initial`/`animate` variants, `drag` enablement — cannot be expressed with
 * Tailwind's `md:` classes, which only toggle CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}
