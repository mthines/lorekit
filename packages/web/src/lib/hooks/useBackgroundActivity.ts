'use client';

import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useEffect, useReducer, useRef } from 'react';
import {
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
  const inFlight = useIsFetching() + useIsMutating();
  const isActive = inFlight > 0;

  const [state, dispatch] = useReducer(nextIndicatorState, 'idle' as const);

  // The machine only cares about the zero ↔ non-zero edges; the count itself
  // changes on every individual request and would otherwise restart the timers.
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
    return undefined;
  }, [state]);

  return isIndicatorVisible(state);
}
