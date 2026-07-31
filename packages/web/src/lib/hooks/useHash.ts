'use client';

import { useEffect, useState } from 'react';

/**
 * The current URL fragment, without the leading `#`.
 *
 * `useSearchParams()` does not cover the fragment — it is never sent to the
 * server and Next's router does not re-render on a fragment-only change — so
 * anything that reacts to an in-page anchor (a sub-nav highlight, a collapsed
 * panel that should open when linked to) has to read it from `window`.
 *
 * Starts empty so the server render and the first client paint agree, then
 * fills in after mount. Listens to `hashchange` (in-page anchor clicks) and
 * `popstate` (back/forward between anchors).
 */
export function useHash(): string {
  const [hash, setHash] = useState('');

  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, ''));
    read();
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);

  return hash;
}
