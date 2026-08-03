'use client';

/**
 * FocusRefetcher
 *
 * Refreshes the dashboard's data when you come back to it — switching tabs,
 * switching apps on macOS, or reopening the installed PWA.
 *
 * React Query's own `refetchOnWindowFocus` is left on and unchanged; this sits
 * beside it for the case it deliberately skips, a query that is still inside
 * its `staleTime`. See `lib/focus-refetch.ts` for why an intentional return is
 * treated differently from background chatter, and for the cooldown.
 *
 * Two listeners, because neither one covers the whole gesture:
 * `visibilitychange` fires for a tab switch or a minimised window but NOT for
 * an app switch that merely puts the window behind another one, and `focus`
 * fires for that case (and for a standalone PWA window regaining key status)
 * but not for a background tab becoming the active one in an already-focused
 * window. Both funnel into the same cooldown, so the overlap costs nothing.
 *
 * Renders nothing — the visible half of this is the TopBar's ActivityIndicator,
 * which lights up because these refetches are ordinary in-flight queries.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { shouldRefetchOnFocus } from '@/lib/focus-refetch';

export function FocusRefetcher() {
  const queryClient = useQueryClient();
  const lastRefetchAt = useRef<number | null>(null);

  useEffect(() => {
    function refresh() {
      // A `focus` event can arrive while the document is still hidden (a
      // background tab being restored); the visibility change that follows is
      // the honest signal, so let that one do the work.
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      if (!shouldRefetchOnFocus({ lastRefetchAt: lastRefetchAt.current, now })) return;
      lastRefetchAt.current = now;

      // Active queries only: refetching every cached query would re-request the
      // pages the user is not looking at. A failure is the queries' own to
      // report through their existing error states.
      void queryClient.refetchQueries({ type: 'active' });
    }

    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [queryClient]);

  return null;
}
