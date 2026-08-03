'use client';

import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useEffect, useReducer, useRef } from 'react';
import {
  MAX_VISIBLE_MS,
  MIN_VISIBLE_MS,
  SHOW_DELAY_MS,
  isIndicatorVisible,
  nextIndicatorState,
} from '@/lib/activity-indicator';

/**
 * Whether the header should currently be showing background activity.
 *
 * The impure shell around `lib/activity-indicator.ts`: React Query reports how
 * much is in flight, this hook turns the zero/non-zero transitions plus two
 * timers into the state machine's events, and the machine decides what shows.
 * Nothing here knows the thresholds' rationale — that lives with the rule.
 *
 * Mutations count as well as queries: archiving a lesson is exactly as much a
 * "the app is talking to the server" moment as a read, and the indicator is
 * about the connection, not about which verb is using it.
 */
export function useBackgroundActivity(): boolean {
  // OBSERVED queries only. A bare `useIsFetching()` counts every query in the
  // cache, including ones no component is subscribed to any more — and the
  // dashboard mints those routinely: each Lore Explorer filter change is a new
  // query key, so the page it replaces is abandoned mid-flight. Whether that
  // abandoned fetch is cancellable then decides how long the header claims the
  // app is busy, which is a detail of one data hook leaking into the chrome.
  // An unobserved query is by definition nothing the user is waiting for.
  const inFlight =
    useIsFetching({ predicate: (query) => query.getObserversCount() > 0 }) + useIsMutating();
  const isActive = inFlight > 0;

  const [state, dispatch] = useReducer(nextIndicatorState, 'idle' as const);

  // The machine only cares about the zero ↔ non-zero edges; the count itself
  // changes on every individual request and would otherwise restart the timers.
  //
  // One consequence of that, worth naming: after the watchdog gives up, work
  // starting while the stuck request is STILL counted raises no edge, so the
  // bar stays down until the count next reaches zero. That is the right way
  // round — the watchdog only ever fires when something is already wrong, and
  // an indicator that resurrects itself every few seconds against a wedged
  // request is the behaviour it exists to stop.
  const wasActive = useRef(false);
  useEffect(() => {
    if (isActive === wasActive.current) return;
    wasActive.current = isActive;
    dispatch(isActive ? 'activity-start' : 'activity-end');
  }, [isActive]);

  useEffect(() => {
    if (state === 'pending') {
      const timer = setTimeout(() => dispatch('delay-elapsed'), SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (state === 'lingering') {
      const timer = setTimeout(() => dispatch('linger-elapsed'), MIN_VISIBLE_MS);
      return () => clearTimeout(timer);
    }
    if (state === 'visible') {
      // The watchdog. Every other exit from `visible` waits on `activity-end`,
      // which a request that never settles never sends — see `MAX_VISIBLE_MS`.
      const timer = setTimeout(() => dispatch('max-visible-elapsed'), MAX_VISIBLE_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state]);

  return isIndicatorVisible(state);
}
